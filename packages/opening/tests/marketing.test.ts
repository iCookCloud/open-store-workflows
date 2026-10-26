import { readFile } from 'node:fs/promises';
import {
  type AnyAssetRecord,
  type AssetRecordOf,
  type Filter,
  MemorySource,
  type PartySlot,
  SHARED_SLOTS,
  type StepCtx,
  createParamReader,
  versionHash,
  type z,
} from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import { deriveAssetGap } from '../src/marketing/asset-gap.js';
import { contentCalendar } from '../src/marketing/content-calendar.js';
import { evaluateCreator, selectCreators } from '../src/marketing/creator-select.js';
import { withMarketingParams } from '../src/marketing/helpers.js';
import { marketingLedger } from '../src/marketing/ledger.js';
import { LedgerEntry } from '../src/marketing/models.js';
import {
  PlanMarketingInput,
  PlanMarketingOutput,
  planMarketing,
} from '../src/marketing/plan-marketing.js';
import { contentCaseSlot } from '../src/slots/content-case.js';
import { contentPlaybookSlot } from '../src/slots/content-playbook.js';
import { MarketingPlanContent } from '../src/templates/marketing-plan.js';

const NOW = '2026-01-10T12:00:00Z';
const HASH = 'a'.repeat(64);
const ref = { slot: 'party', id: 'example-creator', versionHash: HASH };
async function record(slot: string, id: string, data: unknown): Promise<AnyAssetRecord> {
  return {
    slot,
    id,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    updatedAt: NOW,
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
    example: true,
    data,
  };
}
const marketingContent = {
  items: [
    {
      key: 'announce',
      channel: 'exampleSocial',
      title: 'Example announcement',
      dayOffset: -1,
      deliverable: 'Example artwork',
      core: true,
      category: 'example-launch',
      stage: 'exampleBefore',
    },
  ],
  disclosureRules: [{ jurisdiction: 'XE', required: true }],
};
const selection = {
  tiers: ['exampleSmall'],
  formats: ['example-short'],
  audienceLanguages: ['en'],
  mixRoles: ['exampleLocal'],
};
const thresholds = { activeWithinDays: 10, maxPostGapDays: 5, staleDays: 5, minEngagement: 2 };
const fact = {
  partyId: ref.id,
  locality: { local: true, by: 'example:reviewer' },
  recentPostDates: ['2026-01-07', '2026-01-09'],
  audienceLanguages: ['en'],
  mixRole: 'exampleLocal',
};
async function party() {
  return (await record('party', ref.id, {
    name: { en: 'Example Creator' },
    roles: ['creator'],
    status: 'active',
    jurisdictions: ['XE'],
    profiles: {
      creator: {
        platform: 'example-platform',
        tier: 'exampleSmall',
        audience: 100,
        formats: ['example-short'],
        engagementPct: 3,
        lastPostOn: '2026-01-09',
        verifiedOn: '2026-01-09',
      },
    },
  })) as AssetRecordOf<z.infer<typeof PartySlot.schema>>;
}
async function fixture(extra: AnyAssetRecord[] = [], options = { creators: false }) {
  const params: Record<string, number> = {
    'marketing.budget.revenueRate': 0.1,
    'marketing.budget.reserveRate': 0.2,
    'marketing.budget.split.exampleSocial': 1,
    'marketing.ads.stageWeight.exampleBefore': 1,
    'marketing.creator.activeWithinDays': 10,
    'marketing.creator.maxPostGapDays': 5,
    'marketing.creator.staleDays': 5,
    'marketing.creator.minEngagement.exampleSmall': 2,
    'marketing.creator.mixMin.exampleLocal': 1,
    'marketing.creator.mixMax.exampleLocal': 1,
  };
  const records = [
    await record('template', 'example-marketing', {
      kind: 'marketing-plan',
      lang: 'en',
      title: { en: 'Example Plan' },
      format: 'json',
      content: options.creators
        ? { ...marketingContent, creatorSelection: selection }
        : marketingContent,
    }),
    await record('template', 'example-assets', {
      kind: 'asset-plan',
      lang: 'en',
      title: { en: 'Example Assets' },
      format: 'json',
      content: { items: [{ key: 'poster', required: 2, channels: ['exampleSocial'] }] },
    }),
    ...(await Promise.all(
      Object.entries(params).map(([key, value]) => record('params', key, { key, value })),
    )),
    ...extra,
  ];
  const assets = new MemorySource(records, [...SHARED_SLOTS, contentCaseSlot, contentPlaybookSlot]);
  // 故意不预装带 qualifier 的键，模拟通用 runner 只取 ParamDecl 精确键。
  const baseRecords = records.filter(
    (item) =>
      item.slot === 'params' &&
      ['marketing.budget.revenueRate', 'marketing.budget.reserveRate'].includes(item.data.key),
  );
  const ctx: StepCtx = {
    assets,
    params: createParamReader(baseRecords, NOW),
    approvals: [],
    now: NOW,
    actor: 'example:reviewer',
    providers: {},
  };
  const storeSpec = JSON.parse(
    await readFile(
      new URL('../../../examples/sample-store/expected/store-spec.json', import.meta.url),
      'utf8',
    ),
  );
  return {
    records,
    assets,
    ctx,
    input: PlanMarketingInput.parse({ storeSpec, openingDate: '2026-02-01' }),
  };
}
describe('opening marketing', () => {
  it('resolves fetched qualifiers before a generic fallback and keeps fetched ambiguity blocking', async () => {
    const base = await record('params', 'example-base-share', {
      key: 'marketing.budget.split',
      value: 0.7,
    });
    const { ctx } = await fixture([base]);
    const contextual = { ...ctx, params: createParamReader([base], NOW) };
    const scope = { jurisdiction: 'XE', qualifier: 'exampleSocial' };
    const resolved = await withMarketingParams(
      contextual,
      ['marketing.budget.split', 'marketing.budget.split.exampleSocial'],
      scope,
    );
    expect(resolved.params.get('marketing.budget.split', scope)?.value).toBe(1);
    const duplicate = await record('params', 'example-duplicate-share', {
      key: 'marketing.budget.split.exampleSocial',
      value: 0.2,
    });
    const ambiguous = await fixture([base, duplicate]);
    const rejected = await withMarketingParams(
      { ...ambiguous.ctx, params: createParamReader([base], NOW) },
      ['marketing.budget.split', 'marketing.budget.split.exampleSocial'],
      scope,
    );
    expect(rejected.params.get('marketing.budget.split', scope)).toBeUndefined();
    expect(rejected.params.need?.('marketing.budget.split', scope)).toMatchObject({
      kind: 'param',
      reason: 'ambiguous',
    });
  });
  it('rejects review buying, soliciting reviews, and unsupported qualifier identifiers', () => {
    expect(
      MarketingPlanContent.safeParse({
        ...marketingContent,
        reviewPolicy: { buyReviews: true, solicitReviews: false },
      }).success,
    ).toBe(false);
    expect(
      MarketingPlanContent.safeParse({
        ...marketingContent,
        reviewPolicy: { buyReviews: false, solicitReviews: true },
      }).success,
    ).toBe(false);
    expect(
      MarketingPlanContent.safeParse({
        ...marketingContent,
        items: [{ ...marketingContent.items[0], channel: 'invalid-channel' }],
      }).success,
    ).toBe(false);
  });
  it('binds approval to the proposed category and applies only approved budgets', async () => {
    const { input, ctx } = await fixture();
    const pending = await planMarketing.run(input, ctx);
    expect(pending.output).not.toBeNull();
    expect(pending.output!.budgets[0].total).toBeNull();
    expect(pending.needs).toEqual([expect.objectContaining({ kind: 'approval', blocking: false })]);
    const subject = pending.output!.approvalSubjects[0];
    const approved = await planMarketing.run(input, {
      ...ctx,
      approvals: [
        {
          step: 'opening/planMarketing',
          ...subject,
          decision: 'approved',
          by: 'example:reviewer',
          at: NOW,
        },
      ],
    });
    PlanMarketingOutput.parse(approved.output);
    const budget = approved.output!.budgets[0];
    const base = input.storeSpec.body.economics.breakeven;
    expect(budget.total!.amount).toBeCloseTo(
      base.status === 'ok' ? base.revenue.amount * 0.1 : 0,
      2,
    );
    expect(budget.channels[0].stages[0].amount.amount + budget.reserve!.amount).toBe(
      budget.total!.amount,
    );
    expect(approved.output!.coreIncomplete).toEqual(['announce']);
    expect(
      approved.output!.sources.some(
        (source) => source.id === 'marketing.budget.split.exampleSocial',
      ),
    ).toBe(true);
    const shifted = await planMarketing.run(
      { ...input, openingDate: '2026-02-02' },
      {
        ...ctx,
        approvals: [
          {
            step: 'opening/planMarketing',
            ...subject,
            decision: 'approved',
            by: 'example:reviewer',
            at: NOW,
          },
        ],
      },
    );
    expect(shifted.output!.budgets[0].approved).toBe(false);
  });
  it('blocks missing FX, rejects stale artifact hashes and preserves parameter ambiguity', async () => {
    const { input, ctx } = await fixture();
    const ledger = LedgerEntry.parse({
      id: 'example-ad',
      channel: 'exampleSocial',
      status: 'done',
      spend: { amount: 10, currency: 'EUR' },
      visits: 0,
      evidence: [],
    });
    const fx = await planMarketing.run({ ...input, ledger: [ledger] }, ctx);
    expect(fx.output).toBeNull();
    expect(fx.needs).toContainEqual(expect.objectContaining({ kind: 'param', key: 'fx.EUR.USD' }));
    const stale = await planMarketing.run(
      { ...input, storeSpec: { ...input.storeSpec, hash: HASH } },
      ctx,
    );
    expect(stale.output).toBeNull();
    const ambiguous: StepCtx = {
      ...ctx,
      params: {
        get: () => undefined,
        need: (key) => ({ kind: 'param', key, reason: 'ambiguous', blocking: true }),
      },
    };
    const result = await planMarketing.run(input, ambiguous);
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'param', reason: 'ambiguous' }),
    );
  });
  it('evaluates creator gates in order and never guesses a missing posting gap', async () => {
    const record = await party();
    const needs: Parameters<typeof evaluateCreator>[6] = [];
    expect(
      evaluateCreator(record, undefined, selection, '2026-01-10', thresholds, [], needs).reason,
    ).toBe('locality');
    expect(needs).toContainEqual(expect.objectContaining({ action: 'verifyCreatorLocality' }));
    expect(
      evaluateCreator(
        record,
        { ...fact, recentPostDates: undefined },
        selection,
        '2026-01-10',
        thresholds,
        [],
        [],
      ).reason,
    ).toBe('activity');
    const weak = structuredClone(record);
    weak.data.profiles!.creator!.engagementPct = 1;
    expect(evaluateCreator(weak, fact, selection, '2026-01-10', thresholds, [], []).reason).toBe(
      'engagement',
    );
    expect(
      evaluateCreator(
        record,
        { ...fact, audienceLanguages: ['es'] },
        selection,
        '2026-01-10',
        thresholds,
        [],
        [],
      ).reason,
    ).toBe('formatOrLanguage');
    expect(
      evaluateCreator(record, fact, selection, '2026-01-10', thresholds, [], []).eligible,
    ).toBe(true);
  });
  it('pushes local, active, tier-specific filters and explicit limits to the source', async () => {
    const creator = await party();
    const { ctx, assets, input } = await fixture([creator], { creators: true });
    const query = vi.spyOn(assets, 'query');
    const result = await planMarketing.run({ ...input, creatorFacts: [fact] }, ctx);
    expect(result.output!.candidates[0].selected).toBe(true);
    const call = query.mock.calls.find(([slot]) => slot.name === 'party')!;
    expect(call[2]).toMatchObject({ limit: 200, cursor: null });
    expect(JSON.stringify(call[1])).toContain('profiles.creator.lastPostOn');
    expect(JSON.stringify(call[1])).toContain('profiles.creator.engagementPct');
    expect(JSON.stringify(call[1])).toContain('jurisdictions');
    expect(JSON.stringify(call[1])).toContain('exampleSmall');
  });
  it('caps the mix and prefers prior proven collaborations', async () => {
    const p1 = await party();
    p1.id = 'example-a';
    const p2 = await party();
    p2.id = 'example-z';
    const { ctx } = await fixture([p1, p2], { creators: true });
    const allParams = createParamReader(
      (await fixture()).records.filter((record) => record.slot === 'params'),
      NOW,
    );
    const ledger = [
      LedgerEntry.parse({
        id: 'example-paid',
        channel: 'exampleSocial',
        status: 'published',
        spend: { amount: 10, currency: 'USD' },
        visits: 2,
        evidence: ['example:receipt'],
        disclosureEvidence: 'example:disclosure',
        creatorRef: { ...ref, id: p2.id },
      }),
    ];
    const output = await selectCreators(
      selection,
      [
        { ...fact, partyId: p1.id },
        { ...fact, partyId: p2.id },
      ],
      ledger,
      '2026-01-10',
      { ...ctx, params: allParams },
      { jurisdiction: 'XE' },
    );
    expect(
      output.candidates
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.ref.id),
    ).toEqual(['example-z']);
  });
  it('rejects publication without disclosure and illegal cooperation jumps; computes cost-based barter and null CAC', async () => {
    const { ctx } = await fixture();
    const row = LedgerEntry.parse({
      id: 'example-deal',
      channel: 'exampleSocial',
      creatorRef: ref,
      status: 'published',
      spend: { amount: 100, currency: 'USD' },
      visits: 0,
      evidence: [],
    });
    const rejected = marketingLedger([row], [], 'USD', ctx, {});
    expect(rejected.needs).toContainEqual(
      expect.objectContaining({ path: 'ledger.example-deal.disclosureEvidence' }),
    );
    expect(rejected.cac).toBeNull();
    const organic = { ...row, spend: { amount: 0, currency: 'USD' } };
    expect(marketingLedger([organic], [], 'USD', ctx, {}).needs).toEqual([]);
    expect(marketingLedger([organic], [], 'USD', ctx, {}, true).needs).toContainEqual(
      expect.objectContaining({ path: 'ledger.example-deal.disclosureEvidence' }),
    );
    const jump = marketingLedger(
      [{ ...row, disclosureEvidence: 'example:disclosure' }],
      [{ ...row, status: 'candidate' }],
      'USD',
      ctx,
      {},
    );
    expect(jump.needs).toContainEqual(
      expect.objectContaining({ path: 'ledger.example-deal.status' }),
    );
    const barter = marketingLedger(
      [
        {
          ...row,
          status: 'settled',
          barterCost: { amount: 20, currency: 'USD' },
          visits: 4,
          disclosureEvidence: 'example:disclosure',
        },
      ],
      [],
      'USD',
      ctx,
      {},
    );
    expect(barter.cac).toEqual({ amount: 5, currency: 'USD' });
    expect(barter.missingEvidence).toEqual(['example-deal']);
    expect(barter.verifications[0].verdict).toBe('holds');
    const failed = marketingLedger(
      [{ ...row, status: 'settled', disclosureEvidence: 'example:disclosure' }],
      [],
      'USD',
      ctx,
      {},
    );
    expect(failed.verifications[0].verdict).toBe('fails');
  });
  it('excludes skipped assets, caps ready counts, and expands deterministic calendar mix', async () => {
    const gap = deriveAssetGap(
      {
        items: [
          { key: 'a', required: 3, channels: ['exampleSocial'] },
          { key: 'b', required: 5, channels: ['example-web'] },
        ],
      },
      [
        { key: 'a', ready: 1 },
        { key: 'b', ready: 0, status: 'skipped' },
      ],
    );
    expect(gap).toEqual({ required: 3, ready: 1, missing: 2, blockedChannels: ['exampleSocial'] });
    const book = await record('content-playbook', 'example-book', {
      weeks: [{ weekOffset: 1, count: 3, mix: { explain: 0.5, show: 0.5 } }],
      scripts: { explain: ['Explain'], show: ['Show'] },
    });
    contentPlaybookSlot.validate!(book.data);
    const calendar = contentCalendar('2026-01-01', [book]);
    expect(calendar).toHaveLength(3);
    expect(calendar.map((entry) => entry.date)).toEqual(['2026-01-08', '2026-01-10', '2026-01-12']);
    expect(calendar.filter((entry) => entry.goal === 'explain')).toHaveLength(2);
    expect(() =>
      contentPlaybookSlot.validate!({
        weeks: [{ weekOffset: 0, count: 3, mix: { missing: 1 } }],
        scripts: {},
      }),
    ).toThrow('requires a script');
  });
});
