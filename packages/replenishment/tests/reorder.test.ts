import {
  type AnyAssetRecord,
  type AssetRef,
  MemorySource,
  OfferSlot,
  ProductSlot,
  SHARED_SLOTS,
  type SlotDef,
  type StepCtx,
  createParamReader,
  fieldsetHash,
  versionHash,
} from '@osw/core';
import { describe, expect, it } from 'vitest';
import { admitFromOpening } from '../src/admit.js';
import { type ReorderLine, type ReorderOrder, reorderSlot } from '../src/models-reorder.js';
import { advanceReorder, draftReorder, frequentList } from '../src/reorder.js';
import { replenishShare } from '../src/share.js';
import { campaignSlots } from '../src/slots.js';
import { verifyUpstream } from '../src/verify.js';

const now = '2026-02-20T12:00:00Z';
const openedAt = '2026-01-01T00:00:00Z';
const hash = 'a'.repeat(64);
const ref = (slot: string, id: string): AssetRef => ({ slot, id, versionHash: hash });
function line(id = 'example-flour', options: Partial<ReorderLine> = {}): ReorderLine {
  return {
    id,
    key: id,
    weakKey: false,
    productRef: ref('product', id),
    lineKind: 'food',
    name: 'Example flour',
    spec: 'Example large pack',
    qty: 20,
    unit: 'kg',
    priceSource: 'last-paid',
    unitPrice: { amount: 10, currency: 'USD' },
    ...options,
  };
}
function order(
  lines: ReorderLine[],
  at: string,
  state: ReorderOrder['state'] = 'delivered',
): ReorderOrder {
  return {
    storeId: 'example-store',
    supplierId: 'example-supplier',
    lines,
    skipped: [],
    state,
    history: [
      { state: 'draft', at, by: 'example:store' },
      { state: 'submitted', at, by: 'example:store' },
      { state, at, by: 'example:supplier' },
    ],
  };
}
async function record(
  slot: string,
  id: string,
  data: unknown,
  frequency?: 'opening' | 'recurring',
): Promise<AnyAssetRecord> {
  const def = SHARED_SLOTS.find((item) => item.name === slot);
  const fieldsetHashes: Record<string, string> = {};
  for (const [key, fields] of Object.entries(def?.fieldsets ?? {}))
    fieldsetHashes[key] = await fieldsetHash(data as Record<string, unknown>, fields);
  return {
    slot,
    id,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    ...(Object.keys(fieldsetHashes).length ? { fieldsetHashes } : {}),
    coverage: {
      tier: 'general',
      tracks: [],
      workflows: [],
      jurisdictions: [],
      ...(frequency ? { frequency } : {}),
    },
    updatedAt: now,
    example: true,
    data,
  };
}
async function context(extra: AnyAssetRecord[] = [], params: Record<string, number> = {}) {
  const records = [
    await record('store', 'example-store', {
      name: { en: 'Example Noodle Bar' },
      status: 'operating',
      track: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      openedAt: '2026-01-01',
    }),
    await record('party', 'example-supplier', {
      name: { en: 'Example supplier' },
      roles: ['supplier'],
      status: 'active',
    }),
    await product('example-flour'),
    await product('example-other'),
    ...extra,
  ];
  for (const [key, value] of Object.entries({
    'reorder.minIntervals': 2,
    'reorder.graceDays': 2,
    'verify.price.tolerance': 0.1,
    'program.shareWindowDays': 100,
    'program.shareTarget': 0.7,
    ...params,
  }))
    records.push(await record('params', key, { key, value }));
  const assets = new MemorySource(records, [...SHARED_SLOTS, ...campaignSlots, reorderSlot]);
  const ctx: StepCtx = {
    assets,
    now,
    actor: 'example:test',
    params: createParamReader(
      records.filter((item) => item.slot === 'params'),
      now,
    ),
    approvals: [],
    providers: {},
  };
  return { ctx, assets };
}
const product = (id: string, frequency?: 'opening' | 'recurring') =>
  record(
    'product',
    id,
    {
      name: { en: id },
      kind: 'catalog',
      category: 'example-food',
      goodsClass: 'food',
      status: 'active',
    },
    frequency,
  );
const offer = (id: string, options: Record<string, unknown> = {}) =>
  record('offer', id, {
    partyId: 'example-supplier',
    productId: 'example-flour',
    basis: 'catalog',
    use: 'repeat',
    currency: 'USD',
    unit: 'kg',
    tiers: [
      { minQty: 1, unitPrice: 10 },
      { minQty: 20, unitPrice: 8 },
    ],
    moq: 5,
    quotedAt: '2026-01-01',
    ...options,
  });

describe('reorder frequency and pricing', () => {
  it('resolves equally current quotes only through an explicit versioned choice', async () => {
    const first = await offer('example-first');
    const second = await offer('example-second-quote', { tiers: [{ minQty: 1, unitPrice: 7 }] });
    const { ctx } = await context([first, second]);
    const input = {
      storeId: 'example-store',
      currency: 'USD',
      selected: [{ line: line(), supplierId: 'example-supplier' }],
    };
    expect((await draftReorder.run(input, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: expect.stringContaining('offer') }),
    );
    const selected = line('example-flour', {
      offerRef: { slot: 'offer', id: second.id, versionHash: second.versionHash },
    });
    expect(
      (
        await draftReorder.run(
          { ...input, selected: [{ line: selected, supplierId: 'example-supplier' }] },
          ctx,
        )
      ).output?.orders[0].order.lines[0].unitPrice?.amount,
    ).toBe(7);
  });
  it('does not relabel an unaccepted quote as a last-paid price', async () => {
    const { ctx } = await context();
    const response = await draftReorder.run(
      {
        storeId: 'example-store',
        currency: 'USD',
        selected: [
          {
            line: line('example-flour', { priceSource: 'repeat-offer' }),
            supplierId: 'example-supplier',
          },
        ],
      },
      ctx,
    );
    expect(response.needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'requestRepeatQuote' }),
    );
  });
  it('keeps unknown consumables, distinguishes weak specifications, excludes opening-only and pre-opening orders', async () => {
    const weak = line('weak', { productRef: undefined, spec: 'Example small', weakKey: true });
    const other = { ...weak, spec: 'Example large' };
    const { ctx } = await context([
      await product('example-once', 'opening'),
      await record('reorder', 'old', order([line('old-product')], '2025-12-01T00:00:00Z')),
    ]);
    const response = await frequentList.run(
      { storeId: 'example-store', openedAt, seedLines: [weak, other, line('example-once')] },
      ctx,
    );
    expect(response.output?.lines).toHaveLength(2);
    expect(new Set(response.output?.lines.map((item) => item.key)).size).toBe(2);
    expect(response.output?.lines.every((item) => item.weakKey && item.dueAt === null)).toBe(true);
    expect(response.output?.skipped).toEqual(['Example flour']);
  });
  it('needs sufficient intervals and derives median cadence without guessing', async () => {
    const a = await record('reorder', 'a', order([line()], '2026-01-05T00:00:00Z'));
    const b = await record('reorder', 'b', order([line()], '2026-01-15T00:00:00Z'));
    const first = await context([a, b]);
    expect(
      (await frequentList.run({ storeId: 'example-store' }, first.ctx)).output?.lines[0].dueAt,
    ).toBeNull();
    const c = await record('reorder', 'c', order([line()], '2026-02-04T00:00:00Z'));
    const second = await context([a, b, c]);
    const current = (await frequentList.run({ storeId: 'example-store' }, second.ctx)).output
      ?.lines[0];
    expect(current?.dueAt).toBe('2026-02-19T00:00:00.000Z');
    expect(current?.overdue).toBe(false);
  });
  it('uses repeat tiers, converts offer units and splits suppliers', async () => {
    const secondParty = await record('party', 'example-second', {
      name: { en: 'Example second' },
      roles: ['supplier'],
      status: 'active',
    });
    const { ctx } = await context([
      await offer('example-price'),
      secondParty,
      await offer('second-price', {
        partyId: 'example-second',
        productId: 'example-other',
        unit: 'g',
        tiers: [{ minQty: 1, unitPrice: 0.01 }],
        moq: 1,
      }),
    ]);
    const response = await draftReorder.run(
      {
        storeId: 'example-store',
        currency: 'USD',
        selected: [
          { line: line(), supplierId: 'example-supplier' },
          { line: line('example-other'), supplierId: 'example-second' },
        ],
      },
      ctx,
    );
    expect(response.needs).toEqual([]);
    expect(response.output?.orders).toHaveLength(2);
    expect(
      response.output?.orders.find((item) => item.order.supplierId === 'example-supplier')?.order
        .lines[0].unitPrice?.amount,
    ).toBe(8);
    expect(
      response.output?.orders.find((item) => item.order.supplierId === 'example-second')?.order
        .lines[0].unitPrice?.amount,
    ).toBe(10);
  });
  it('reports missing FX and does not silently substitute last-paid when MOQ fails', async () => {
    const { ctx } = await context([await offer('example-eur', { currency: 'EUR' })]);
    const fx = await draftReorder.run(
      {
        storeId: 'example-store',
        currency: 'USD',
        selected: [{ line: line(), supplierId: 'example-supplier' }],
      },
      ctx,
    );
    expect(fx.output).toBeNull();
    expect(fx.needs).toContainEqual(expect.objectContaining({ kind: 'param', key: 'fx.EUR.USD' }));
    const low = await draftReorder.run(
      {
        storeId: 'example-store',
        currency: 'USD',
        selected: [{ line: line('example-flour', { qty: 1 }), supplierId: 'example-supplier' }],
      },
      ctx,
    );
    expect(low.needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'meetRepeatMinimum' }),
    );
  });
  it('locks a last-paid price to approval and requests an unpriced quote', async () => {
    const { ctx } = await context();
    const input = {
      storeId: 'example-store',
      currency: 'USD',
      selected: [{ line: line(), supplierId: 'example-supplier' }],
    };
    const first = await draftReorder.run(input, ctx);
    const need = first.needs.find((item) => item.kind === 'approval');
    expect(need?.kind).toBe('approval');
    if (need?.kind !== 'approval') throw new Error('Expected price approval');
    const approved = {
      ...ctx,
      approvals: [
        {
          step: need.step,
          subject: need.subject,
          subjectHash: need.subjectHash,
          decision: 'approve',
          by: 'example:store',
          at: now,
        },
      ],
    };
    expect(
      (await draftReorder.run(input, approved)).output?.orders[0].order.lines[0].priceSource,
    ).toBe('last-paid');
    expect(
      (
        await draftReorder.run(
          {
            ...input,
            selected: [
              { ...input.selected[0], line: line('example-flour', { unitPrice: undefined }) },
            ],
          },
          ctx,
        )
      ).needs,
    ).toContainEqual(expect.objectContaining({ kind: 'action', action: 'requestRepeatQuote' }));
  });
});

describe('reorder state and upstream evidence', () => {
  it('does not let a future operator approval hide a wrong supplier identity', async () => {
    const submitted = order([line()], now, 'submitted');
    const { ctx } = await context([await record('reorder', 'example-identity', submitted)]);
    const subjectHash = await versionHash(submitted.lines);
    const current = {
      step: 'replenishment/advanceReorder',
      subject: 'confirm:example-identity',
      subjectHash,
      decision: 'confirm',
      role: 'supplier',
      party: ref('party', 'example-wrong-supplier'),
      by: 'example:current-supplier',
      at: now,
    };
    const future = {
      ...current,
      role: 'operator',
      by: 'example:future-operator',
      at: '2030-01-01T00:00:00Z',
    };
    const blocked = await advanceReorder.run(
      { orderId: 'example-identity', action: 'confirm' },
      { ...ctx, approvals: [current, future] },
    );
    expect(blocked.output).toBeNull();
    expect(blocked.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'approval.party' }),
    );
    const correct = { ...current, party: ref('party', 'example-supplier') };
    const accepted = await advanceReorder.run(
      { orderId: 'example-identity', action: 'confirm' },
      { ...ctx, approvals: [correct, future] },
    );
    expect(accepted.output?.order.state).toBe('confirmed');
    expect(accepted.output?.order.history.at(-1)?.by).toBe('example:current-supplier');
    const denied = await advanceReorder.run(
      { orderId: 'example-identity', action: 'confirm' },
      { ...ctx, approvals: [{ ...correct, decision: 'deny' }, future] },
    );
    expect(denied.needs).toContainEqual(expect.objectContaining({ kind: 'approval' }));
  });
  it('allows cancellation of an unpriced stored draft', async () => {
    const draft = order(
      [line('example-flour', { unitPrice: undefined, priceSource: 'unpriced' })],
      now,
      'draft',
    );
    draft.history = [{ state: 'draft', at: now, by: 'example:store' }];
    const { ctx } = await context([await record('reorder', 'example-cancel', draft)]);
    expect(
      (await advanceReorder.run({ orderId: 'example-cancel', action: 'cancel' }, ctx)).output?.order
        .state,
    ).toBe('cancelled');
  });
  it('requires renewed store approval for negotiated prices and records quote deviations', async () => {
    const quote = await offer('example-repeat-price');
    const first = await offer('example-initial-price', {
      use: 'project',
      tiers: [{ minQty: 1, unitPrice: 10 }],
    });
    const quotedLine = line('example-flour', {
      priceSource: 'repeat-offer',
      unitPrice: { amount: 8, currency: 'USD' },
      offerRef: { slot: 'offer', id: quote.id, versionHash: quote.versionHash },
      initialOfferRef: { slot: 'offer', id: first.id, versionHash: first.versionHash },
    });
    const submitted = order([quotedLine], now, 'submitted');
    const { ctx } = await context([
      quote,
      first,
      await record('reorder', 'example-negotiated', submitted),
    ]);
    const changed = structuredClone(submitted);
    changed.lines[0].unitPrice = { amount: 12, currency: 'USD' };
    const subjectHash = await versionHash(changed.lines);
    const supplier = {
      step: 'replenishment/advanceReorder',
      subject: 'confirm:example-negotiated',
      subjectHash,
      decision: 'confirm',
      role: 'operator',
      at: now,
      by: 'example:operator',
    };
    const blocked = await advanceReorder.run(
      { orderId: 'example-negotiated', action: 'confirm', order: changed },
      { ...ctx, approvals: [supplier] },
    );
    expect(blocked.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: 'submit:example-negotiated' }),
    );
    const response = await advanceReorder.run(
      { orderId: 'example-negotiated', action: 'confirm', order: changed },
      {
        ...ctx,
        approvals: [
          supplier,
          { ...supplier, subject: 'submit:example-negotiated', decision: 'submit', role: 'store' },
        ],
      },
    );
    expect(response.output?.order.state).toBe('confirmed');
    expect(response.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'repeatPrice', verdict: 'fails' }),
    );
    expect(response.verifications).toContainEqual(
      expect.objectContaining({
        dimension: 'offerPrice',
        verdict: 'fails',
        measured: expect.objectContaining({ expected: 8, actual: 12, delta: 4 }),
      }),
    );
  });
  it('keeps BOM and external stores separate in the same segment', async () => {
    const { ctx } = await context();
    const response = await replenishShare(
      {
        stores: [
          { storeId: 'example-store', segmentKey: 'XE|example-noodle', seedLines: [line()] },
          { storeId: 'example-external', segmentKey: 'XE|example-noodle', seedLines: null },
        ],
      },
      ctx,
    );
    expect(response.output).toHaveLength(2);
    expect(response.output?.find((item) => item.basis === 'bom')).toMatchObject({
      stores: 1,
      byLines: 0,
    });
    expect(response.output?.find((item) => item.basis === 'none')).toMatchObject({
      stores: 1,
      byLines: null,
    });
  });
  it('requires store and supplier roles and rejects mutation after confirmation', async () => {
    const { ctx, assets } = await context();
    const draft = order([line()], now, 'draft');
    draft.history = [{ state: 'draft', at: now, by: 'example:store' }];
    const linesHash = await versionHash(draft.lines);
    const approved: StepCtx = {
      ...ctx,
      approvals: [
        {
          step: 'replenishment/advanceReorder',
          subject: 'submit:example-order',
          subjectHash: linesHash,
          decision: 'submit',
          role: 'store',
          by: 'example:store',
          at: now,
        },
      ],
    };
    const submitted = await advanceReorder.run(
      { orderId: 'example-order', action: 'submit', order: draft },
      approved,
    );
    expect(submitted.output?.order.state).toBe('submitted');
    assets.add(await record('reorder', 'example-order', submitted.output?.order));
    const wrongRole = await advanceReorder.run(
      { orderId: 'example-order', action: 'confirm' },
      approved,
    );
    expect(wrongRole.needs).toContainEqual(expect.objectContaining({ kind: 'approval' }));
    const confirmation = {
      ...ctx,
      approvals: [
        {
          step: 'replenishment/advanceReorder',
          subject: 'confirm:example-order',
          subjectHash: linesHash,
          decision: 'confirm',
          role: 'supplier',
          party: ref('party', 'example-supplier'),
          by: 'example:supplier',
          at: now,
        },
      ],
    };
    const confirmed = await advanceReorder.run(
      { orderId: 'example-order', action: 'confirm' },
      confirmation,
    );
    expect(confirmed.output?.order.state).toBe('confirmed');
    assets.add(await record('reorder', 'example-order', confirmed.output?.order));
    const changed = structuredClone(confirmed.output?.order) as ReorderOrder;
    changed.lines[0].unitPrice = { amount: 1, currency: 'USD' };
    expect(
      (
        await advanceReorder.run(
          {
            orderId: 'example-order',
            action: 'receipt',
            order: changed,
            receipt: [{ key: 'example-flour', qty: 20 }],
          },
          ctx,
        )
      ).output,
    ).toBeNull();
    const received = await advanceReorder.run(
      { orderId: 'example-order', action: 'receipt', receipt: [{ key: 'example-flour', qty: 10 }] },
      ctx,
    );
    expect(received.output?.order.state).toBe('delivered');
    expect(received.verifications[0].verdict).toBe('fails');
  });
  it('computes BOM-based shares and leaves external denominators unknown', async () => {
    const { ctx } = await context([
      await record('reorder', 'example-reorder', order([line()], '2026-02-01T00:00:00Z')),
    ]);
    const response = await replenishShare(
      {
        stores: [
          {
            storeId: 'example-store',
            segmentKey: 'XE|example-noodle',
            seedLines: [line(), line('example-oil')],
          },
          { storeId: 'example-external', segmentKey: 'XE|example-other', seedLines: null },
        ],
      },
      ctx,
    );
    expect(response.output?.find((item) => item.basis === 'bom')?.byLines).toBe(0.5);
    expect(response.output?.find((item) => item.basis === 'none')?.byLines).toBeNull();
  });
  it('uses recipe ingredients as the denominator and keeps unfinished windows pending', async () => {
    const menu = await record('menu', 'example-menu', {
      title: { en: 'Example menu' },
      cuisine: 'example',
      tracks: ['example-noodle'],
      items: [{ id: 'example-dish', name: { en: 'Example dish' }, recipeId: 'example-recipe' }],
    });
    const recipe = await record('recipe', 'example-recipe', {
      name: { en: 'Example recipe' },
      yield: { value: 1, unit: 'pcs' },
      ingredients: [
        { productId: 'example-flour', qty: 1, unit: 'kg' },
        { productId: 'example-oil', qty: 1, unit: 'L' },
      ],
    });
    const { ctx } = await context(
      [
        menu,
        recipe,
        await record('reorder', 'example-reorder', order([line()], '2026-01-20T00:00:00Z')),
      ],
      { 'verify.menu.windowDays': 30, 'verify.menu.minShare': 0.7 },
    );
    const input = {
      storeId: 'example-store',
      openedAt,
      menuRef: { slot: 'menu', id: menu.id, versionHash: menu.versionHash },
    };
    expect((await verifyUpstream.run(input, ctx)).verifications[0]).toMatchObject({
      verdict: 'fails',
      measured: { actual: 0.5 },
    });
    expect(
      (await verifyUpstream.run({ ...input, openedAt: '2026-02-15T00:00:00Z' }, ctx))
        .verifications[0].verdict,
    ).toBe('pending');
  });
});

async function admissionInput(productRef?: AssetRef) {
  const money = { amount: 10, currency: 'USD' };
  const body = {
    currency: 'USD',
    lines: [
      {
        id: 'example-flour',
        lineKind: 'food',
        productRef,
        qty: 10,
        unit: 'kg',
        category: 'example-food',
        name: 'Example flour',
        zone: 'example-zone',
        spec: 'Example pack',
        qtyRule: { kind: 'manual' },
        qtyBasis: { status: 'manual', note: 'Example quantity' },
        dimsBasis: { status: 'manual', note: 'Example dimensions' },
        budgetKey: 'opening_inventory',
        evidence: [],
        derivedFrom: { kind: 'manual', ref: 'example' },
        pricingMode: 'whole',
        components: [],
        modelCostPerUnit: null,
        parts: [],
        modelWarnings: [],
        sourcing: null,
        costBasis: 'model',
        unitPrice: { ...money, basis: 'estimate' },
      },
    ],
    totals: { model: money, chosen: money, byBudgetKey: {} },
  };
  const bom = {
    kind: 'Bom',
    artifactVersion: '0.1.0',
    id: 'example-bom',
    hash: await versionHash(body),
    producedBy: { step: 'fitout-bom/run', pkg: '@osw/fitout-bom', pkgVersion: '0.1.0' },
    storeId: 'example-store',
    inputs: [],
    sources: [],
    createdAt: now,
    example: true,
    body,
  };
  const openingBody = {
    menuRef: ref('menu', 'example-menu'),
    bomRef: { kind: 'Bom', id: bom.id, hash: bom.hash },
    decidedAt: openedAt,
    track: 'example-noodle',
    jurisdiction: 'XE',
    timezone: 'UTC',
    openingDate: '2026-01-01',
    status: 'completed',
    staffing: [],
    certMatrix: {
      plan: ref('template', 'example-training'),
      seats: [],
      cells: [],
      summary: {
        planTotal: 0,
        staffed: 0,
        gaps: [],
        certRequired: 0,
        certPassed: 0,
        criticalRequired: 0,
        criticalPassed: 0,
        criticalPending: 0,
        expiring: 0,
        hollow: false,
        ready: true,
      },
    },
    checklist: {
      template: ref('template', 'example-checklist'),
      firstDay: 0,
      lastDay: 0,
      items: [],
    },
    issues: [],
    release: { current: { state: 'ready', blockers: [] }, signed: null },
    marketing: {
      template: ref('template', 'example-marketing'),
      items: [],
      ledger: [],
      assetGap: { required: 0, ready: 0, missing: 0, blockedChannels: [] },
    },
    reviews: [],
    handoff: { storeStatus: 'operating', openedAt: '2026-01-01' },
  };
  const opening = {
    kind: 'OpeningRecord',
    artifactVersion: '0.1.0',
    id: 'example-opening',
    hash: await versionHash(openingBody),
    producedBy: { step: 'opening/run', pkg: '@osw/opening', pkgVersion: '0.1.0' },
    storeId: 'example-store',
    inputs: [],
    sources: [],
    createdAt: now,
    example: true,
    body: openingBody,
  };
  return admitFromOpening.input.parse({ opening, bom });
}

describe('opening admission', () => {
  it('requires released operating stores and preserves unknown consumables without product references', async () => {
    const input = await admissionInput();
    const { ctx, assets } = await context();
    expect((await admitFromOpening.run(input, ctx)).output?.seedLines[0].weakKey).toBe(true);
    assets.add(
      await record('store', 'example-store', {
        name: { en: 'Example Noodle Bar' },
        status: 'preparing',
        track: 'example-noodle',
        jurisdiction: 'XE',
        timezone: 'UTC',
      }),
    );
    expect((await admitFromOpening.run(input, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'admitStore' }),
    );
  });
  it('rejects changed artifact hashes and stale or missing product references', async () => {
    const productRecord = await product('example-flour');
    const input = await admissionInput({
      slot: 'product',
      id: productRecord.id,
      versionHash: productRecord.versionHash,
    });
    const { ctx } = await context([productRecord]);
    expect((await admitFromOpening.run(input, ctx)).output?.seedLines).toHaveLength(1);
    input.bom.body.lines[0].name = 'Edited after opening approval';
    expect((await admitFromOpening.run(input, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'bom.hash' }),
    );
    const missing = await admissionInput(ref('product', 'example-missing'));
    expect((await admitFromOpening.run(missing, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'product' }),
    );
  });
});
