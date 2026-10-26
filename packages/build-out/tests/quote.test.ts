import {
  type AssetRecordOf,
  type Need,
  type Param,
  createParamReader,
  versionHash,
} from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import {
  Estimated,
  Quoted,
  estimateHours,
  levelBids,
  priceQuote,
  projectClientQuote,
  takeoff,
} from '../src/index.js';
import { approveStep, fixture, refreshSource, rehash, stages } from './fixtures.js';

describe('takeoff and installation rates', () => {
  it('rejects duplicate BOM line IDs at the shared Bom contract', async () => {
    const f = await fixture();
    f.input.bom.body.lines.push(structuredClone(f.input.bom.body.lines[0]));
    await rehash(f.input);
    const r = await takeoff.run(f.input, f.ctx);
    expect(r.output).toBeNull();
    expect(r.needs).toContainEqual(expect.objectContaining({ kind: 'input', blocking: true }));
  });
  it('excludes landlord work and requires a current operator approval', async () => {
    const f = await fixture();
    const result = await takeoff.run(f.input, f.ctx);
    expect(result.output?.lines.map((l) => l.id)).toEqual(['example-counter', 'example-appliance']);
    f.input.quantities['example-counter'] = 11;
    const changed = await takeoff.run(f.input, f.ctx);
    expect(changed.output).toBeNull();
    expect(changed.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', blocking: true }),
    );
    expect(changed.verifications.some((v) => v.dimension === 'qty' && v.verdict === 'fails')).toBe(
      true,
    );
  });
  it('rejects unmapped landlord work and wrong-store artifacts', async () => {
    const f = await fixture();
    f.input.landlordScope = [];
    f.input.site.storeId = 'example-other-store';
    await rehash(f.input);
    const r = await takeoff.run(f.input, f.ctx);
    expect(r.output).toBeNull();
    expect(r.needs.filter((n) => n.kind === 'input').length).toBeGreaterThanOrEqual(2);
  });
  it('rejects changed artifact bodies and old delivery BOM references', async () => {
    const f = await fixture();
    f.input.bom.body.lines[0].qty++;
    expect((await takeoff.run(f.input, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'Bom.hash' }),
    );
    f.input.bom.hash = await versionHash(f.input.bom.body);
    expect((await takeoff.run(f.input, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'delivery.inputs' }),
    );
  });
  it('groups matching queries, paginates candidates, chooses priority and specific jurisdiction', async () => {
    const f = await fixture();
    const state = stages(f).takeoff;
    state.input.site.body.jurisdiction = 'XE-AA';
    state.lines.push({ ...state.lines[0], id: 'example-counter-copy' });
    const generic = f.records.find((r) => r.id === 'example-carpentry-rate');
    f.records.push({
      ...generic,
      id: 'example-specific',
      coverage: { ...generic.coverage, jurisdictions: ['XE-AA'] },
      data: { ...generic.data, hoursPerUnit: 3 },
    });
    refreshSource(f);
    const query = vi.spyOn(f.ctx.assets, 'query');
    const r = await estimateHours.run(state, f.ctx);
    expect(query).toHaveBeenCalledTimes(2);
    expect(r.output?.lines[0].install.hoursPerUnit).toBe(3);
    expect(r.output?.lines[2].install.hoursPerUnit).toBe(3);
  });
  it('uses data-driven zero and fallback rates, returns a need when no match, and preserves overrides', async () => {
    const f = await fixture();
    const state = stages(f).takeoff;
    const row = f.records.find((r) => r.id === 'example-carpentry-rate');
    row.data.hoursPerUnit = 0;
    refreshSource(f);
    expect((await estimateHours.run(state, f.ctx)).output?.lines[0].install.hoursPerUnit).toBe(0);
    state.lines[0].install = { hoursPerUnit: 9, basis: 'Measured manually', overridden: true };
    row.data.hoursPerUnit = 6;
    expect((await estimateHours.run(state, f.ctx)).output?.lines[0].install.hoursPerUnit).toBe(9);
    state.lines[1].category = 'example-unmatched';
    expect((await estimateHours.run(state, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'install-rate' }),
    );
    f.records.push({
      ...row,
      id: 'example-fallback',
      data: { ...row.data, match: {}, priority: -10, hoursPerUnit: 1 },
    });
    refreshSource(f);
    expect((await estimateHours.run(state, f.ctx)).output?.lines[1].install.hoursPerUnit).toBe(1);
  });
});

describe('construction quote and customer view', () => {
  it('independently reconciles goods, installation, all fee bases and downstream freight', async () => {
    const f = await fixture();
    const q = stages(f).quoted.quote;
    expect(q.totals).toEqual({
      goods: { amount: 1400, currency: 'USD' },
      labor: { amount: 560, currency: 'USD' },
      fees: { amount: 330, currency: 'USD' },
      total: { amount: 2290, currency: 'USD' },
      laborHours: 28,
    });
    expect(q.fees.map((v) => v.amount.amount).sort((a, b) => a - b)).toEqual([50, 60, 80, 140]);
    expect(q.lines[0].partsCheck).toBe('holds');
    const view = projectClientQuote(q, f.input);
    expect(view.lines[0].materials.main).toEqual(['Example material']);
    const text = JSON.stringify(view);
    for (const key of [
      'basePrice',
      'rateRef',
      'modelCostPerUnit',
      'bomQty',
      'parts',
      'sources',
      'laborRate',
    ])
      expect(text).not.toContain(`"${key}"`);
  });
  it('preserves installation hours while self-install and self-freight remove corresponding charges', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.input.options = { selfInstall: true, selfFreight: true };
    const { result } = await approveStep(2, state, { ...f.ctx, approvals: [] }, 'client', 'accept');
    const quote = Quoted.parse(result.output).quote;
    expect(quote.totals.total.amount).toBe(1650);
    expect(quote.totals.labor.amount).toBe(0);
    expect(quote.lines[0].install.hoursPerUnit).toBe(2);
    expect(quote.fees.every((fee) => !fee.freight)).toBe(true);
  });
  it('rounds unit price before multiplying quantity and loads qualified labor/FX keys in batches', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.lines = [
      {
        ...state.lines[0],
        basePrice: { amount: 0.333, currency: 'EUR' },
        qty: 3,
        install: { hoursPerUnit: 0, basis: 'No installation', overridden: true },
      },
    ];
    state.fees = [];
    state.input.bom.body.lines[0].parts = [];
    f.records.push({
      ...f.records[0],
      id: 'example-fx',
      data: { key: 'fx.EUR.USD', value: 1, appliesTo: { jurisdictions: ['XE'] } },
    });
    refreshSource(f);
    const { result } = await approveStep(2, state, { ...f.ctx, approvals: [] }, 'client', 'accept');
    const quote = Quoted.parse(result.output).quote;
    expect(quote.lines[0].unitPrice.amount).toBe(0.33);
    expect(quote.lines[0].lineTotal.amount).toBe(0.99);
    expect(quote.fxUsed).toEqual({ 'fx.EUR.USD': 1 });
    expect(quote.totals.total.amount).toBe(0.99);
  });
  it('returns structured parameter needs for missing FX and refuses invalid hourly units', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.lines[0].basePrice.currency = 'EUR';
    state.input.bom.body.lines[0].parts = [];
    const r = await priceQuote.run(state, f.ctx);
    expect(r.output).toBeNull();
    expect(r.needs).toContainEqual(expect.objectContaining({ kind: 'param', key: 'fx.EUR.USD' }));
    f.ctx.params = createParamReader(
      [
        { ...f.records[0], data: { key: 'labor.hourlyRate', value: 20, unit: 'USD' } },
      ] as AssetRecordOf<Param>[],
      f.ctx.now,
    );
    expect((await priceQuote.run(stages(f).estimated, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'params.labor.hourlyRate' }),
    );
  });
  it('binds approvals to changed quotes, enforces roles and rejects future approvals', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.lines[0].qty++;
    expect((await priceQuote.run(state, f.ctx)).output).toBeNull();
    const original = stages(f).estimated;
    const old = f.ctx.approvals.find((a) => a.step === priceQuote.id)!;
    for (const bad of [
      { ...old, role: 'operator' },
      { ...old, at: '2030-01-01T00:00:00Z' },
    ])
      expect((await priceQuote.run(original, { ...f.ctx, approvals: [bad] })).output).toBeNull();
    expect(
      (await priceQuote.run(original, { ...f.ctx, approvals: [{ ...old, decision: 'decline' }] }))
        .needs,
    ).toContainEqual(expect.objectContaining({ action: 'reviseQuote' }));
  });
  it('freezes accepted quotes and verifies parts against model cost without treating factory labor as installation', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.input.previousPlan = f.approved.artifact;
    state.lines[0].qty = 21;
    expect((await priceQuote.run(state, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ action: 'changeOrder' }),
    );
    state.input.previousPlan = undefined;
    state.input.bom.body.lines[0].parts[0].rate.amount = 400;
    const r = await priceQuote.run(state, f.ctx);
    expect(r.verifications.some((v) => v.dimension === 'partsSum' && v.verdict === 'fails')).toBe(
      true,
    );
  });
});

describe('bid leveling', () => {
  it('counts distinct parties, identifies different missing lines and requires operator explanation', async () => {
    const f = await fixture();
    const state = stages(f).quoted;
    const offers = f.records.filter((r) => r.slot === 'offer');
    offers[0].data.serviceLineRefs = ['example-counter'];
    offers[1].data.serviceLineRefs = ['example-appliance'];
    refreshSource(f);
    const pending = await levelBids.run(state, { ...f.ctx, approvals: [] });
    expect(pending.needs.some((n) => n.kind === 'approval')).toBe(true);
    const withoutNote = await approveStep(
      3,
      state,
      { ...f.ctx, approvals: [] },
      'operator',
      'proceed',
    );
    expect(withoutNote.result.output).toBeNull();
    const { result } = await approveStep(
      3,
      state,
      { ...f.ctx, approvals: [] },
      'operator',
      'proceed',
      'Two available synthetic bids',
    );
    expect(result.output.bids.map((b: { missingLineIds: string[] }) => b.missingLineIds)).toEqual([
      ['example-appliance'],
      ['example-counter'],
    ]);
  });
  it('rejects expired bids and overlapping offers from the same party', async () => {
    const f = await fixture();
    const state = stages(f).quoted;
    const offers = f.records.filter((r) => r.slot === 'offer');
    offers[0].data.validUntil = '2025-01-01';
    refreshSource(f);
    expect((await levelBids.run(state, f.ctx)).output).toBeNull();
    offers[0].data.validUntil = '2030-01-01';
    offers[1].data.partyId = offers[0].data.partyId;
    refreshSource(f);
    const result = await levelBids.run(state, f.ctx);
    expect(
      result.needs.some((n: Need) => n.kind === 'input' && n.reason.includes('Overlapping')),
    ).toBe(true);
  });
});

describe('pricing and provenance edge cases', () => {
  it('keeps zero installation at zero even when product unit rounding changes the subtotal', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    state.lines = [{ ...state.lines[0], basePrice: { amount: 0.333, currency: 'USD' }, qty: 3 }];
    state.fees = [];
    state.input.options.selfInstall = true;
    const { result } = await approveStep(2, state, { ...f.ctx, approvals: [] }, 'client', 'accept');
    expect(result.output.quote.totals.goods.amount).toBe(0.99);
    expect(result.output.quote.totals.labor.amount).toBe(0);
  });
  it('loads a qualified trade rate before falling back, and refuses qualified ambiguity', async () => {
    const f = await fixture();
    const state = stages(f).estimated;
    const rate = {
      ...f.records[0],
      id: 'example-trade-rate',
      data: {
        key: 'labor.hourlyRate.carpentry',
        value: 30,
        unit: 'USD/h',
        appliesTo: { jurisdictions: ['XE'] },
      },
    };
    f.records.push(rate);
    refreshSource(f);
    const { result } = await approveStep(2, state, { ...f.ctx, approvals: [] }, 'client', 'accept');
    expect(result.output.quote.lines[0].laborPerUnit.amount).toBe(60);
    f.records.push({ ...rate, id: 'example-ambiguous-rate' });
    refreshSource(f);
    const ambiguous = await priceQuote.run(state, f.ctx);
    expect(ambiguous.output).toBeNull();
    expect(ambiguous.needs).toContainEqual(
      expect.objectContaining({
        kind: 'param',
        key: 'labor.hourlyRate.carpentry',
        reason: 'ambiguous',
      }),
    );
  });
  it('does not mark a result as synthetic when a consumed parameter is not synthetic', async () => {
    const f = await fixture();
    f.records.find((r) => r.data.key === 'labor.hourlyRate').example = undefined;
    refreshSource(f);
    const result = await priceQuote.run(stages(f).estimated, f.ctx);
    expect(result.output?.example).toBe(false);
  });
  it('refuses contradictory decisions at the same timestamp', async () => {
    const f = await fixture();
    const consent = f.ctx.approvals.find((a) => a.step === priceQuote.id)!;
    const result = await priceQuote.run(stages(f).estimated, {
      ...f.ctx,
      approvals: [consent, { ...consent, decision: 'decline' }],
    });
    expect(result.output).toBeNull();
  });
  it('continues through bounded candidate pages instead of overlooking a later match', async () => {
    const f = await fixture();
    const state = stages(f).takeoff;
    const generic = f.records.find((r) => r.id === 'example-carpentry-rate');
    f.records.push({
      ...generic,
      id: 'example-later-rate',
      data: { ...generic.data, priority: 99, hoursPerUnit: 7 },
    });
    refreshSource(f);
    const query = f.ctx.assets.query.bind(f.ctx.assets);
    const spy = vi
      .spyOn(f.ctx.assets, 'query')
      .mockImplementation((slot, filter, options) => query(slot, filter, { ...options, limit: 1 }));
    const result = await estimateHours.run(state, f.ctx);
    expect(result.output?.lines[0].install.hoursPerUnit).toBe(7);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
