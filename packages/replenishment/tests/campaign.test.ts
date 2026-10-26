import {
  type AnyAssetRecord,
  AssetRef,
  type Campaign,
  type MemorySource,
  type Need,
  OswSourceError,
  type StepCtx,
  versionHash,
  type z,
} from '@osw/core';
import { describe, expect, it } from 'vitest';
import { selectAudience } from '../src/audience.js';
import { campaignContentHash, lintNewsletterBody, planCampaign } from '../src/campaign.js';
import { classifyStores } from '../src/classify.js';
import { matchSuppliers } from '../src/match.js';
import { SegmentRuleset, SendLog, StoreContact } from '../src/models.js';
import { narrowerThan, normalizeRule, pickVariant } from '../src/rule.js';
import { campaignSlots } from '../src/slots.js';
import { decideSend, inSendWindow } from '../src/throttle.js';
import { NOW, context, record } from './fixtures.js';

const rules = {
  segmentRegions: ['XE-AA', 'XE-AA-BB', 'XE-CC'],
  regionTiers: { local: ['XE-AA'] },
  supplyCats: ['example-food', 'example-drink'],
  trackSupply: {
    'example-noodle': ['example-food'],
    'example-cafe': ['example-drink'],
    'example-empty': [],
  },
  categoryAliases: { 'example noodles': 'example-noodle' },
};
const policy = {
  'nl.runMax': 2,
  'nl.dayMax': 10,
  'nl.trial': 2,
  'nl.holdHours': 1,
  'nl.window.tz': 'UTC',
  'nl.window.days': 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
  'nl.window.fromHour': 0,
  'nl.window.toHour': 24,
  'nl.breaker.complaint': 0,
  'nl.breaker.unsub': 0.5,
  'nl.breaker.bounce': 0.5,
  'nl.breaker.failed': 0.5,
  'nl.breaker.minSample': 2,
  'nl.breaker.minAttempts': 2,
  'nl.capDays': 3,
  'nl.matrix.maxDims': 3,
  'nl.matrix.minCell': 2,
};
const store = (jurisdiction = 'XE-AA', track = 'example-noodle', extra = {}) => ({
  name: { en: 'Example store' },
  status: 'operating',
  track,
  jurisdiction,
  timezone: 'UTC',
  ...extra,
});
const supplier = (
  id: string,
  jurisdictions = ['XE'],
  tracks: string[] = [],
  cats = ['example-food', 'example-drink'],
) =>
  record('party', id, {
    name: { en: 'Example supplier' },
    roles: ['supplier'],
    status: 'active',
    jurisdictions,
    tracks,
    profiles: { supplier: { supplyCats: cats } },
  });
const product = (id: string, category = 'example-food') =>
  record('product', id, {
    name: { en: 'Example product' },
    kind: 'catalog',
    category,
    goodsClass: 'food',
    status: 'active',
  });
const offer = (
  id: string,
  partyId = 'example-supplier',
  productId = 'example-product',
  extra = {},
) =>
  record('offer', id, {
    partyId,
    productId,
    basis: 'catalog',
    use: 'repeat',
    currency: 'USD',
    unit: 'kg',
    tiers: [{ minQty: 0, unitPrice: 10 }],
    quotedAt: '2026-01-01',
    ...extra,
  });
const contact = (id: string, storeId: string, address: string, extra = {}) =>
  record('store-contact', id, {
    storeId,
    channel: 'email',
    address,
    verdict: 'valid',
    source: 'example',
    verifiedAt: '2026-01-01T00:00:00Z',
    ...extra,
  });
const log = (id: string, extra = {}) =>
  record('send-log', id, {
    campaignId: 'example-campaign',
    topicKey: 'example-topic',
    variantKey: 'example-main',
    contactId: 'example-contact',
    status: 'sent',
    event: 'none',
    at: '2026-02-01T10:00:00Z',
    ...extra,
  });
async function base(records: AnyAssetRecord[] = [], params = policy) {
  return context(
    [await record('segment-ruleset', 'example-rules', rules), ...records],
    params,
    campaignSlots,
  );
}
async function campaign(overrides: Partial<z.infer<typeof Campaign>> = {}) {
  const lead = { slot: 'template', id: 'example-lead', versionHash: '0'.repeat(64) };
  const service = { slot: 'template', id: 'example-service', versionHash: '1'.repeat(64) };
  const draft = {
    campaignId: 'example-campaign',
    supplierId: 'example-supplier',
    topicKey: 'example-topic',
    topicRule: { tracks: ['example-noodle'], regions: ['XE'] },
    dims: ['scene'],
    variants: [
      {
        variantKey: 'example-main',
        cell: { scene: 'example' },
        rule: { tracks: ['example-noodle'], regions: ['XE'] },
        lead,
        service,
        productIds: ['example-product'],
        subject: 'Example topic',
        preheader: 'Example preheader',
        expected: 10,
      },
    ],
    sharedBlocks: [],
    state: 'draft' as const,
    ...overrides,
  };
  return { ...draft, contentHash: await campaignContentHash(draft) };
}
function approved(ctx: StepCtx, c: z.infer<typeof Campaign>): StepCtx {
  return {
    ...ctx,
    approvals: [
      {
        step: 'replenishment/selectAudience',
        subject: `campaign:${c.campaignId}`,
        subjectHash: c.contentHash,
        decision: 'send',
        by: 'example:operator',
        at: NOW,
      },
    ],
  };
}

async function audienceFixture(extra: AnyAssetRecord[] = []) {
  return base([
    await supplier('example-supplier'),
    await product('example-product'),
    await offer('example-offer'),
    await record('store', 'example-store', store()),
    await contact('example-contact', 'example-store', 'example@example.com'),
    ...extra,
  ]);
}

describe('replenishment campaign slots and rules', () => {
  it('rejects empty axes, unknown supply categories and address-bearing send logs', () => {
    expect(
      SegmentRuleset.safeParse({ ...rules, trackSupply: { 'example-noodle': ['unknown'] } })
        .success,
    ).toBe(false);
    expect(
      StoreContact.safeParse({
        storeId: 'example',
        channel: 'email',
        address: 'x',
        verdict: 'valid',
        source: 'example',
        verifiedAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      SendLog.parse({
        campaignId: 'c',
        topicKey: 't',
        variantKey: 'v',
        contactId: 'i',
        status: 'sent',
        event: 'clicked',
        at: NOW,
        address: 'example@example.com',
      }),
    ).not.toHaveProperty('address');
    expect(() => normalizeRule({ regions: [] })).toThrow();
  });
  it('normalizes axes, checks tier-prefix narrowing and picks the first matching key', () => {
    expect(normalizeRule({ tracks: ['EXAMPLE-NOODLE', 'example-noodle'] })).toEqual({
      tracks: ['example-noodle'],
    });
    expect(narrowerThan({ regions: ['XE-AA-BB'] }, { regions: ['local'] }, rules)).toBe(true);
    expect(narrowerThan({ regions: ['XE'] }, { regions: ['local'] }, rules)).toBe(false);
    expect(narrowerThan({}, { tracks: ['example-noodle'] }, rules)).toBe(false);
    expect(
      pickVariant(
        [
          { variantKey: 'b', rule: {} },
          { variantKey: 'a', rule: {} },
        ],
        { track: 'example-noodle', jurisdiction: 'XE-AA' },
        rules,
      )?.variantKey,
    ).toBe('a');
  });
  it('lints required unsubscribe and all unknown placeholders before approval', () => {
    expect(lintNewsletterBody('Example {{UNSUB}}')).toEqual([]);
    expect(lintNewsletterBody('<!-- Example --> {{UNKNOWN}}')).toHaveLength(3);
  });
});

describe('replenishment classify and supplier matching', () => {
  it('uses the longest prefix, preserves explicit empty tracks and verifies category drift', async () => {
    const ctx = await base([
      await record(
        'store',
        'opened',
        store('XE-AA-BB', 'example-noodle', { origin: 'opened', supplyCategories: ['wrong'] }),
      ),
      await record('store', 'intake', store('XE-AA', 'example-empty', { origin: 'intake' })),
      await record('store', 'unknown', store('XF', 'example-noodle')),
    ]);
    const r = await classifyStores.run({ rulesetId: 'example-rules' }, ctx);
    expect(r.output?.total).toBe(3);
    expect(r.output?.segments.map((s) => s.key)).toEqual([
      'XE-AA-BB|example-noodle',
      'XE-AA|example-empty',
    ]);
    expect(r.output?.segments[1].supplyCats).toEqual([]);
    expect(r.output?.unclassified.count).toBe(1);
    expect(r.verifications[0]).toMatchObject({ verdict: 'fails', dimension: 'supplyCategories' });
    const replay = await ctx.assets.query(
      (await import('@osw/core')).StoreSlot,
      r.output!.segments[1].filter,
    );
    expect(replay.items.map((s) => s.id)).toEqual(['intake']);
  });
  it('falls back to paginated scanning for actual core count overflow', async () => {
    const records = await Promise.all(
      Array.from({ length: 205 }, (_, i) => record('store', `example-${i}`, store())),
    );
    const ctx = await base(records);
    ctx.assets.count = async () => {
      throw new OswSourceError('too_many');
    };
    expect((await classifyStores.run({ rulesetId: 'example-rules' }, ctx)).output?.total).toBe(205);
  });
  it('reports hidden classification fields and does not treat backend outages as empty audiences', async () => {
    const hidden = await record(
      'store',
      'hidden',
      store('XE-AA', 'example-noodle', { supplyCategories: ['example-food'] }),
    );
    hidden.redacted = ['supplyCategories'];
    hidden.data.supplyCategories = undefined;
    const ctx = await base([hidden]);
    expect((await classifyStores.run({ rulesetId: 'example-rules' }, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset' }),
    );
    ctx.assets.count = async () => {
      throw new Error('Example backend unavailable');
    };
    await expect(classifyStores.run({ rulesetId: 'example-rules' }, ctx)).rejects.toThrow(
      'Example backend unavailable',
    );
  });
  it('blocks impossible replay filters explicitly instead of emitting over-limit filters', async () => {
    const nested = {
      ...rules,
      segmentRegions: ['XE', ...Array.from({ length: 30 }, (_, index) => `XE-A${index}`)],
    };
    const ctx = context(
      [await record('segment-ruleset', 'example-rules', nested)],
      policy,
      campaignSlots,
    );
    expect((await classifyStores.run({ rulesetId: 'example-rules' }, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'ruleset.segmentRegions' }),
    );
  });
  it('records the first failed gate by store count without scoring', async () => {
    const ctx = await base([
      await supplier('example-supplier', ['XE-AA'], ['example-noodle']),
      await product('example-product'),
      await offer('example-offer'),
    ]);
    const f = { field: 'status' as const, op: 'eq' as const, value: 'operating' };
    const segments = [
      {
        key: 'region',
        region: 'XE-CC',
        track: 'example-noodle',
        supplyCats: ['example-food'],
        count: 3,
        filter: f,
      },
      {
        key: 'cats',
        region: 'XE-AA',
        track: 'example-cafe',
        supplyCats: ['example-drink'],
        count: 4,
        filter: f,
      },
      {
        key: 'track',
        region: 'XE-AA',
        track: 'example-cafe',
        supplyCats: ['example-food'],
        count: 5,
        filter: f,
      },
      {
        key: 'ok',
        region: 'XE-AA',
        track: 'example-noodle',
        supplyCats: ['example-food'],
        count: 6,
        filter: f,
      },
    ];
    const r = await matchSuppliers.run({ segments }, ctx);
    expect(r.output?.[0]).toMatchObject({
      offerIds: ['example-offer'],
      segments: [{ key: 'ok', count: 6 }],
      blocked: { region: 3, cats: 4, track: 5 },
    });
  });
});

describe('replenishment matrix campaign', () => {
  async function matrix() {
    const records: AnyAssetRecord[] = [];
    const variants = [];
    const cells = [
      ['XE-AA', 'example-noodle', 1],
      ['XE-AA', 'example-cafe', 3],
      ['XE-CC', 'example-noodle', 3],
      ['XE-CC', 'example-cafe', 3],
    ] as const;
    for (let i = 0; i < cells.length; i++) {
      const [region, track, count] = cells[i];
      for (let j = 0; j < count; j++)
        records.push(await record('store', `store-${i}-${j}`, store(region, track)));
      const lead = await record('template', `lead-${i}`, {
        kind: 'newsletter-block',
        lang: 'en',
        title: { en: 'Example lead' },
        format: 'markdown',
        body: `Example lead ${i}`,
      });
      const service = await record('template', `service-${i}`, {
        kind: 'newsletter-block',
        lang: 'en',
        title: { en: 'Example service' },
        format: 'markdown',
        body: 'Example service {{UNSUB}}',
      });
      records.push(lead, service);
      variants.push({
        variantKey: `example-${i}`,
        cell: { region, scene: track },
        rule: { regions: [region], tracks: [track] },
        lead: { slot: 'template', id: lead.id, versionHash: lead.versionHash },
        service: { slot: 'template', id: service.id, versionHash: service.versionHash },
        productIds: [`product-${i}`],
        subject: `Example ${i}`,
        preheader: 'Example',
        expected: 999,
      });
    }
    const ctx = await base(records);
    const segmentation = (await classifyStores.run({ rulesetId: 'example-rules' }, ctx)).output!;
    return {
      ctx,
      input: {
        rulesetId: 'example-rules',
        campaignId: 'example-campaign',
        supplierId: 'example-supplier',
        topicKey: 'example-topic',
        topicRule: { regions: ['XE'] },
        dims: [
          { key: 'region', values: ['XE-AA', 'XE-CC'] },
          { key: 'scene', values: ['example-noodle', 'example-cafe'] },
        ],
        variants,
        sharedBlocks: [],
        segmentation,
      },
    };
  }
  it('merges one undersized cell into its adjacent tier, preserving all ten stores', async () => {
    const { ctx, input } = await matrix();
    const r = await planCampaign.run(input, ctx);
    expect(r.needs).toEqual([]);
    expect(r.output?.variants).toHaveLength(3);
    expect(r.output?.variants.reduce((n, v) => n + v.expected, 0)).toBe(10);
    expect(r.output?.variants.map((v) => v.expected).sort()).toEqual([3, 3, 4]);
  });
  it('derives a stable campaign identity for the same external source and supplier', async () => {
    const { ctx, input } = await matrix();
    const first = await planCampaign.run({ ...input, sourceRef: 'example-issue' }, ctx);
    const second = await planCampaign.run(
      { ...input, campaignId: 'another-id', sourceRef: 'example-issue' },
      ctx,
    );
    expect(first.output?.campaignId).toMatch(/^source-/);
    expect(second.output?.campaignId).toBe(first.output?.campaignId);
  });
  it('rejects variants with identical leads and requires new content approval after a subject edit', async () => {
    const { ctx, input } = await matrix();
    input.variants[3].lead = input.variants[2].lead;
    expect((await planCampaign.run(input, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'variants' }),
    );
    const c = await campaign();
    const changed = {
      ...c,
      variants: c.variants.map((v) => ({ ...v, subject: 'Changed example' })),
    };
    expect(
      (
        await selectAudience.run(
          { campaign: changed, rulesetId: 'example-rules' },
          approved(ctx, c),
        )
      ).needs,
    ).toContainEqual(expect.objectContaining({ kind: 'approval' }));
  });
});

describe('replenishment audience', () => {
  it('returns contact intents without addresses and keeps queued rows deduplicated after delivery events', async () => {
    const c = await campaign();
    const ctx = await audienceFixture();
    const selected = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(selected.output?.intents).toEqual([
      { contactId: 'example-contact', storeId: 'example-store', variantKey: 'example-main' },
    ]);
    expect(JSON.stringify(selected)).not.toContain('example@example.com');
    (ctx.assets as MemorySource).add(await log('queued', { status: 'queued', event: 'delivered' }));
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .output?.funnel.recent,
    ).toBe(1);
  });
  it('counts the first exclusion and deduplicates shared addresses using the earliest contact record', async () => {
    const c = await campaign();
    const ctx = await audienceFixture([
      await record('store', 'later-store', store()),
      await contact('later-contact', 'later-store', 'EXAMPLE@example.com', {
        createdAt: '2026-01-02T00:00:00Z',
      }),
      await log('already-sent', { contactId: 'later-contact' }),
    ]);
    const r = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(r.output?.funnel).toMatchObject({ duplicate: 1, recent: 1, selected: 0 });
    (ctx.assets as MemorySource).add(
      await record('suppression', 'blocked', {
        address: 'example@example.com',
        reason: 'optout',
        at: NOW,
      }),
    );
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .output?.funnel.optout,
    ).toBe(1);
  });
  it('enforces the supplier gates even when a caller submits a broad approved campaign directly', async () => {
    const c = await campaign();
    const ctx = await audienceFixture();
    (ctx.assets as MemorySource).add(await supplier('example-supplier', ['XF']));
    const r = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(r.output?.intents).toEqual([]);
    expect(r.output?.funnel.supplier).toBe(1);
  });
  it.each([
    ['store-contact', 'address'],
    ['suppression', 'reason'],
    ['suppression', 'address'],
    ['send-log', 'status'],
    ['send-log', 'contactId'],
  ])('returns an asset need before reading redacted %s.%s', async (slot, field) => {
    const c = await campaign();
    const ctx = await audienceFixture();
    const hidden =
      slot === 'store-contact'
        ? await contact('example-contact', 'example-store', 'example@example.com')
        : slot === 'suppression'
          ? await record('suppression', 'hidden', {
              address: 'example@example.com',
              reason: 'optout',
              at: NOW,
            })
          : await log('hidden');
    hidden.redacted = [field];
    delete hidden.data[field];
    (ctx.assets as MemorySource).add(hidden);
    const outcome = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(outcome.output).toBeNull();
    expect(outcome.needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot, blocking: true }),
    );
    expect(JSON.stringify(outcome)).not.toContain('example@example.com');
  });
  it('honors an optout stored on any later alias before choosing the earliest contact', async () => {
    const c = await campaign();
    const ctx = await audienceFixture([
      await record('store', 'later-store', store()),
      await contact('later-contact', 'later-store', 'EXAMPLE@example.com', {
        createdAt: '2026-01-02T00:00:00Z',
        verdict: 'optout',
      }),
    ]);
    const outcome = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(outcome.output?.intents).toEqual([]);
    expect(outcome.output?.funnel).toMatchObject({ optout: 1, duplicate: 1, selected: 0 });
  });
  it.each(['closed', 'other-track'])(
    'honors a case-and-space normalized optout alias on an out-of-scope %s store',
    async (kind) => {
      const c = await campaign();
      const ctx = await audienceFixture([
        await record(
          'store',
          'outside-store',
          store('XE-AA', kind === 'other-track' ? 'example-cafe' : 'example-noodle', {
            status: kind === 'closed' ? 'closed' : 'operating',
          }),
        ),
        await contact('outside-contact', 'outside-store', '  ExAmPlE@ExAmPlE.CoM  ', {
          verdict: 'optout',
        }),
      ]);
      const outcome = await selectAudience.run(
        { campaign: c, rulesetId: 'example-rules' },
        approved(ctx, c),
      );
      expect(outcome.output?.intents).toEqual([]);
      expect(outcome.output?.funnel).toMatchObject({ total: 1, optout: 1, selected: 0 });
    },
  );
  it.each([
    ['closed', 'sent'],
    ['closed', 'queued'],
    ['other-track', 'sent'],
    ['other-track', 'queued'],
  ])('honors an out-of-scope %s alias with a %s send reservation', async (kind, status) => {
    const c = await campaign();
    const ctx = await audienceFixture([
      await record(
        'store',
        'outside-store',
        store('XE-AA', kind === 'other-track' ? 'example-cafe' : 'example-noodle', {
          status: kind === 'closed' ? 'closed' : 'operating',
        }),
      ),
      await contact('outside-contact', 'outside-store', '  ExAmPlE@ExAmPlE.CoM  '),
      await log('outside-send', { contactId: 'outside-contact', status, event: 'delivered' }),
    ]);
    const outcome = await selectAudience.run(
      { campaign: c, rulesetId: 'example-rules' },
      approved(ctx, c),
    );
    expect(outcome.output?.intents).toEqual([]);
    expect(outcome.output?.funnel).toMatchObject({ total: 1, recent: 1, selected: 0 });
  });
  it('rejects substring false positives after the case-insensitive address lookup', async () => {
    const c = await campaign();
    const ctx = await audienceFixture([
      await record(
        'store',
        'outside-store',
        store('XE-AA', 'example-noodle', { status: 'closed' }),
      ),
      await contact('outside-contact', 'outside-store', 'prefix-example@example.com', {
        verdict: 'optout',
      }),
      await record('suppression', 'unrelated-suppression', {
        address: 'prefix-example@example.com',
        reason: 'optout',
        at: NOW,
      }),
    ]);
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .output?.intents,
    ).toHaveLength(1);
  });
  it('matches suppression addresses using the same case-and-space normalization', async () => {
    const c = await campaign();
    const ctx = await audienceFixture([
      await record('suppression', 'normalized-suppression', {
        address: '  ExAmPlE@ExAmPlE.CoM  ',
        reason: 'optout',
        at: NOW,
      }),
    ]);
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .output?.funnel.optout,
    ).toBe(1);
  });
  it('handles more than two hundred topic tracks without an oversized core filter', async () => {
    const c = await campaign({
      topicRule: {
        tracks: ['example-noodle', ...Array.from({ length: 200 }, (_, i) => `example-track-${i}`)],
        regions: ['XE'],
      },
    });
    const ctx = await audienceFixture();
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .output?.intents,
    ).toHaveLength(1);
  });
  it('requires each policy parameter rather than making up a send cap', async () => {
    const c = await campaign();
    const ctx = await audienceFixture();
    ctx.params = { get: () => undefined };
    expect(
      (await selectAudience.run({ campaign: c, rulesetId: 'example-rules' }, approved(ctx, c)))
        .needs,
    ).toContainEqual(expect.objectContaining({ kind: 'param', key: 'nl.runMax' }));
  });
});

describe('replenishment throttle', () => {
  it('honors weekday and overnight windows in the declared timezone', () => {
    expect(
      inSendWindow('2026-02-03T01:00:00Z', { tz: 'UTC', days: 'Mon', fromHour: 22, toHour: 3 }),
    ).toBe(true);
    expect(
      inSendWindow('2026-02-03T12:00:00Z', { tz: 'UTC', days: 'Mon', fromHour: 22, toHour: 3 }),
    ).toBe(false);
  });
  it('stops the whole sender on one over-threshold complaint', async () => {
    const c = await campaign();
    const ctx = await base([await log('complaint', { event: 'complained' })]);
    expect(
      (await decideSend.run({ campaign: c, webhookReady: true }, approved(ctx, c))).output
        ?.decision,
    ).toBe('pause-all');
  });
  it('blocks every campaign in the same source and requires an explicit domain resume', async () => {
    const a = await campaign();
    const b = await campaign({ campaignId: 'example-campaign-b' });
    const ctx = await base([await log('complaint', { event: 'complained' })]);
    const first = await decideSend.run({ campaign: a, webhookReady: true }, approved(ctx, a));
    const blockedB = await decideSend.run({ campaign: b, webhookReady: true }, approved(ctx, b));
    expect(first.output?.decision).toBe('pause-all');
    expect(blockedB.output?.decision).toBe('pause-all');
    const regular = approved(ctx, b);
    regular.approvals = [
      ...regular.approvals,
      {
        step: 'replenishment/decideSend',
        subject: `resume:${b.campaignId}`,
        subjectHash: blockedB.output!.statsHash,
        decision: 'resume',
        role: 'operator',
        by: 'example:operator',
        at: NOW,
      },
    ];
    expect((await decideSend.run({ campaign: b }, regular)).output?.decision).toBe('pause-all');
    const need = blockedB.needs.find(
      (entry): entry is Extract<Need, { kind: 'approval' }> => entry.kind === 'approval',
    )!;
    const resumed = {
      ...regular,
      approvals: [
        ...regular.approvals,
        {
          step: need.step,
          subject: need.subject,
          subjectHash: need.subjectHash,
          decision: 'resume',
          role: 'operator',
          by: 'example:operator',
          at: NOW,
        },
      ],
    };
    const resumedB = await decideSend.run({ campaign: b, webhookReady: true }, resumed);
    expect(resumedB.output).toMatchObject({
      decision: 'send',
      count: 2,
      domainBreakerFrom: 'complaint',
    });
    const baseline = resumedB.output!.domainBreakerFrom;
    expect(
      (
        await decideSend.run(
          { campaign: b, webhookReady: true, domainBreakerFrom: baseline },
          resumed,
        )
      ).output?.decision,
    ).toBe('send');
    (ctx.assets as MemorySource).add(await log('new-complaint', { event: 'complained', at: NOW }));
    expect(
      (
        await decideSend.run(
          { campaign: b, webhookReady: true, domainBreakerFrom: baseline },
          resumed,
        )
      ).output?.decision,
    ).toBe('pause-all');
  });
  it('cannot bypass the domain breaker using an arbitrary baseline or a changed prefix event', async () => {
    const c = await campaign();
    const ctx = approved(
      await base([await log('a', { event: 'complained' }), await log('b', { event: 'delivered' })]),
      c,
    );
    const baseline = 'b';
    const blocked = await decideSend.run({ campaign: c, domainBreakerFrom: baseline }, ctx);
    expect(blocked.output?.decision).toBe('pause-all');
    const need = blocked.needs.find(
      (entry): entry is Extract<Need, { kind: 'approval' }> => entry.kind === 'approval',
    )!;
    ctx.approvals = [
      ...ctx.approvals,
      {
        step: need.step,
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision: 'resume',
        role: 'operator',
        by: 'example:operator',
        at: NOW,
      },
    ];
    (ctx.assets as MemorySource).add(await log('b', { event: 'clicked' }));
    expect(
      (await decideSend.run({ campaign: c, domainBreakerFrom: baseline }, ctx)).output?.decision,
    ).toBe('pause-all');
  });
  it('returns an asset need for hidden status in domain delivery records', async () => {
    const c = await campaign();
    const hidden = await log('hidden');
    hidden.redacted = ['status'];
    hidden.data.status = undefined;
    const outcome = await decideSend.run({ campaign: c }, approved(await base([hidden]), c));
    expect(outcome.output).toBeNull();
    expect(outcome.needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'send-log' }),
    );
  });
  it('caps trial sends by the daily allowance and counts queued reservations', async () => {
    const c = await campaign();
    const ctx = await base([await log('queued', { status: 'queued', at: NOW })], {
      ...policy,
      'nl.dayMax': 2,
    });
    expect((await decideSend.run({ campaign: c }, approved(ctx, c))).output).toMatchObject({
      decision: 'send',
      count: 1,
    });
  });
  it('holds after a full trial without verified feedback even after the observation period', async () => {
    const c = await campaign();
    const ctx = await base([await log('a'), await log('b')]);
    expect(
      (await decideSend.run({ campaign: c, webhookReady: true }, approved(ctx, c))).output,
    ).toMatchObject({ decision: 'hold', count: 0 });
  });
  it('holds while the trial observation period remains and requires content approval on changes', async () => {
    const c = await campaign();
    const ctx = await base([
      await log('a', { event: 'delivered', at: '2026-02-02T11:30:00Z' }),
      await log('b', { at: '2026-02-02T11:30:00Z' }),
    ]);
    expect(
      (await decideSend.run({ campaign: c, webhookReady: true }, approved(ctx, c))).output
        ?.decision,
    ).toBe('hold');
    const changed = { ...c, variants: c.variants.map((v) => ({ ...v, subject: 'Changed' })) };
    expect((await decideSend.run({ campaign: changed }, approved(ctx, c))).output?.decision).toBe(
      'pause',
    );
  });
  it('advances the breaker baseline on an exact-statistics resume and ignores earlier failures', async () => {
    const c = await campaign({ state: 'paused' });
    const ctx = approved(
      await base([
        await log('a', { status: 'failed', event: 'delivered' }),
        await log('b', { status: 'failed' }),
      ]),
      c,
    );
    const paused = await decideSend.run({ campaign: c, webhookReady: true }, ctx);
    const need = paused.needs.find(
      (n): n is Extract<Need, { kind: 'approval' }> => n.kind === 'approval',
    )!;
    ctx.approvals = [
      ...ctx.approvals,
      {
        step: 'replenishment/decideSend',
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision: 'resume',
        at: NOW,
        by: 'example:operator',
      },
    ];
    const resumed = await decideSend.run({ campaign: c, webhookReady: true }, ctx);
    expect(resumed.output).toMatchObject({ decision: 'send', breakerFrom: 'b', count: 2 });
  });
});
