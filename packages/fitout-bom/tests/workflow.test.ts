import {
  type MemorySource,
  MenuSlot,
  OfferSlot,
  ProductSlot,
  RecipeSlot,
  assetRef,
  versionHash,
  z,
} from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import { lineTemplateSlot } from '../src/slots/index.js';
import { deriveMenuLines } from '../src/steps/derive-menu-lines.js';
import { freezeBom } from '../src/steps/freeze-bom.js';
import { priceModel } from '../src/steps/price-model.js';
import { quoteBom } from '../src/steps/quote-bom.js';
import { resolveProducts } from '../src/steps/resolve-products.js';
import { scaleToSite } from '../src/steps/scale-to-site.js';
import { sourceLines } from '../src/steps/source-lines.js';
import { verifyOffers } from '../src/steps/verify-offers.js';
import { run, workflow } from '../src/workflow.js';
import { approve, context, draft, fixture, line, money, record } from './fixtures.js';
async function sourcedFixture() {
  const f = await fixture();
  const ctx = context(f.records);
  const priced = await priceModel({ draft: f.draft }, ctx);
  expect(priced.output).not.toBeNull();
  const sourceInput = { draft: priced.output!, openingTarget: f.site.body.openingTarget };
  const waiting = await sourceLines(sourceInput, ctx);
  ctx.approvals = approve(waiting.needs, 'example-holds');
  const sourced = await sourceLines(sourceInput, ctx);
  expect(sourced.output).not.toBeNull();
  return { f, ctx, sourced: sourced.output! };
}
describe('supplier selection and verification', () => {
  it('requires version-bound selection and keeps both prices and parts', async () => {
    const { f, ctx, sourced } = await sourcedFixture();
    const selected = sourced.draft.lines[0];
    expect(selected.offerRef?.id).toBe('example-holds');
    expect(selected.parts).toHaveLength(1);
    expect(selected.modelCostPerUnit).toEqual(money(100));
    expect(selected.sourcing?.offerPrice).toEqual(money(100));
    const changed = structuredClone(sourced.draft);
    changed.lines[0].qty = 3;
    const stale = await sourceLines(
      { draft: changed, openingTarget: f.site.body.openingTarget },
      ctx,
    );
    expect(stale.output).toBeNull();
    expect(stale.needs.some((n) => n.kind === 'approval')).toBe(true);
  });
  it('compares every candidate with holds/fails/pending and measured delta', async () => {
    const { ctx, sourced } = await sourcedFixture();
    const verified = await verifyOffers(sourced, ctx);
    const offers = verified.verifications.filter((v) => v.asset.slot === 'offer');
    expect(offers.map((v) => v.verdict)).toEqual(['holds', 'pending', 'fails']);
    expect(offers.find((v) => v.verdict === 'fails')?.measured?.delta).toBe(-100);
  });
  it('marks estimated whole price, missing model, and missing FX pending', async () => {
    const { ctx, sourced } = await sourcedFixture();
    const whole = structuredClone(sourced);
    whole.draft.lines[0].pricingMode = 'whole';
    whole.draft.lines[0].components = [];
    whole.draft.lines[0].wholeEstimate = { unit: money(100), basis: 'estimate' };
    expect(
      (await verifyOffers(whole, ctx)).verifications
        .filter((v) => v.asset.slot === 'offer')
        .every((v) => v.verdict === 'pending'),
    ).toBe(true);
    const missing = structuredClone(sourced);
    missing.draft.lines[0].modelCostPerUnit = null;
    expect(
      (await verifyOffers(missing, ctx)).verifications.every((v) => v.verdict === 'pending'),
    ).toBe(true);
    const fx = structuredClone(sourced);
    for (const c of fx.candidates['sample-line']) c.unitPrice = null;
    expect(
      (await verifyOffers(fx, ctx)).verifications.find((v) => v.asset.id === 'example-holds')
        ?.verdict,
    ).toBe('holds');
  });
  it('batches offer searches for 500 lines into three bounded queries', async () => {
    const ctx = context();
    const spy = vi.spyOn(ctx.assets, 'query');
    const lines = Array.from({ length: 500 }, (_, i) =>
      line({
        id: `line-${i}`,
        productRef: { slot: 'product', id: `product-${i}`, versionHash: '0'.repeat(64) },
      }),
    );
    const response = await sourceLines({ draft: draft(lines), openingTarget: '2026-02-01' }, ctx);
    expect(response.output).toBeNull();
    expect(spy.mock.calls.filter((c) => c[0].name === 'offer')).toHaveLength(3);
    expect(response.needs.filter((n) => n.kind === 'action')).toHaveLength(500);
  });
  it('rejects expired, future, wrong-unit and below-MOQ offers', async () => {
    const f = await fixture();
    const variants = await Promise.all([
      record(OfferSlot, 'expired', { ...f.offers[0].data, validUntil: '2025-12-31' }),
      record(OfferSlot, 'future', { ...f.offers[0].data, validFrom: '2026-02-01' }),
      record(OfferSlot, 'moq', { ...f.offers[0].data, moq: 100 }),
      record(OfferSlot, 'unit', { ...f.offers[0].data, unit: 'kg' }),
    ]);
    const ctx = context([f.product, f.party, ...variants]);
    const waiting = await sourceLines({ draft: f.draft, openingTarget: '2026-02-01' }, ctx);
    ctx.approvals = approve(waiting.needs, 'none');
    const out = await sourceLines({ draft: f.draft, openingTarget: '2026-02-01' }, ctx);
    expect(out.output?.candidates['sample-line']).toHaveLength(0);
  });
});
describe('site, product and menu rules', () => {
  it('scales area and treats absent utility service as failing', async () => {
    const f = await fixture();
    const product = await record(ProductSlot, f.product.id, {
      ...f.product.data,
      utilities: { powerKw: 10, gas: true, exhaust: true },
    });
    f.draft.lines[0].productRef = assetRef(product);
    f.draft.lines[0].qtyRule = { kind: 'site', metric: 'area', factor: 0.1, lossPct: 0 };
    f.site.body.conditions.push(
      { key: 'powerCapacity', measure: { value: 100, unit: 'kVA' }, verdict: 'holds' },
      { key: 'gasService', measure: { value: false }, verdict: 'fails' },
      { key: 'exhaustPath', measure: { value: 'none' }, verdict: 'fails' },
    );
    const out = await scaleToSite(
      { draft: f.draft, store: f.store, site: f.site },
      context([product]),
    );
    expect(out.output).toBeNull();
    expect(out.needs.some((n) => n.kind === 'input')).toBe(true);
    expect(out.needs.filter((n) => n.kind === 'approval')).toHaveLength(2);
  });
  it('does not automatically pick between products with the same normalized name', async () => {
    const f = await fixture();
    const other = await record(ProductSlot, 'example-other', {
      ...f.product.data,
      name: { en: 'Example Table' },
    });
    const ctx = context([f.product, other]);
    const input = draft();
    const first = await resolveProducts({ draft: input }, ctx);
    expect(first.output).toBeNull();
    ctx.approvals = approve(first.needs, other.id);
    expect((await resolveProducts({ draft: input }, ctx)).output?.lines[0].productRef?.id).toBe(
      other.id,
    );
  });
  it('converts gross recipe units, sums dishes and rounds opening inventory to carton units', async () => {
    const f = await fixture();
    const food = await record(ProductSlot, 'example-food', {
      name: { en: 'Example Ingredient' },
      kind: 'catalog',
      category: 'food.example',
      goodsClass: 'food',
      status: 'active',
      carton: { units: 10, grossWeightKg: 10, lMm: 100, wMm: 100, hMm: 100 },
    });
    const recipe = await record(RecipeSlot, 'example-recipe', {
      name: { en: 'Example Recipe' },
      yield: { value: 2, unit: 'pcs' },
      ingredients: [{ productId: food.id, qty: 3, unit: 'pcs' }],
    });
    const menu = await record(MenuSlot, 'example-menu', {
      title: { en: 'Example Menu' },
      cuisine: 'example',
      tracks: ['example'],
      items: [{ id: 'dish', name: { en: 'Example Dish' }, recipeId: recipe.id }],
      derives: { ingredients: [], equipment: [], sop: [], coldchain: false },
    });
    const template = await record(lineTemplateSlot, 'food-template', {
      shape: 'components',
      lineKind: 'food',
      category: 'food',
      budgetKey: 'opening_inventory',
      defaults: { geometry: {}, waste: 0, laborRate: money(0), minLabor: money(0), complexity: 1 },
      components: [],
    });
    f.store.body.concept.nonFood = false;
    f.store.body.menu.approved = [assetRef(menu)];
    f.store.body.menu.status = 'approved';
    const output = await deriveMenuLines(
      {
        draft: draft([]),
        store: f.store,
        foodTemplateId: template.id,
        menuPlans: [
          {
            menuRef: assetRef(menu),
            coverDays: 3,
            items: [{ menuItemId: 'dish', recipeRef: assetRef(recipe), servingsPerDay: 5 }],
          },
        ],
      },
      context([food, recipe, menu, template]),
    );
    expect(output.output?.lines[0].qty).toBe(30);
    expect(output.output?.lines[0].coverDays).toBe(3);
    expect(output.output?.lines[0].qtyBasis.status).toBe('derived');
  });
});
describe('freeze and complete workflow', () => {
  it('runs via shared workflow registration, stops at approvals and yields reproducible BOM', async () => {
    const f = await fixture();
    const ctx = context(f.records);
    const input = { draft: f.draft, store: f.store, site: f.site };
    const first = await run(input, ctx);
    expect(first.artifact).toBeNull();
    expect(
      first.needs.some((n) => n.kind === 'approval' && n.step === 'fitout-bom/sourceLines'),
    ).toBe(true);
    ctx.approvals = approve(first.needs, 'example-holds');
    const second = await run(input, ctx);
    expect(second.artifact).toBeNull();
    expect(
      second.needs.some((n) => n.kind === 'approval' && n.step === 'fitout-bom/freezeBom'),
    ).toBe(true);
    ctx.approvals = [...ctx.approvals, ...approve(second.needs)];
    const final = await run(input, ctx);
    expect(final.artifact?.body.totals.chosen).toEqual(money(200));
    expect(final.artifact?.hash).toBe(await versionHash(final.artifact!.body));
    expect(
      final.steps.verifyOffers.verifications.filter((v) => v.asset.slot === 'offer'),
    ).toHaveLength(3);
    expect((await run(input, ctx)).artifact).toEqual(final.artifact);
    expect((ctx.assets as MemorySource).verifications).toHaveLength(0);
    for (const step of workflow.steps) {
      expect(() => z.toJSONSchema(step.input)).not.toThrow();
      expect(() => z.toJSONSchema(step.output)).not.toThrow();
    }
  });
  it('changes invalidate freeze approvals and unknown product/model data blocks freeze', async () => {
    const { f, ctx, sourced } = await sourcedFixture();
    const input = { draft: sourced.draft, store: f.store, site: f.site };
    const first = await freezeBom(input, ctx);
    ctx.approvals = [...ctx.approvals, ...approve(first.needs)];
    expect((await freezeBom(input, ctx)).output).not.toBeNull();
    const changed = structuredClone(input);
    changed.draft.lines[0].name = 'Changed Example Table';
    expect((await freezeBom(changed, ctx)).output).toBeNull();
    const missing = structuredClone(input);
    missing.draft.lines[0].modelCostPerUnit = null;
    expect(
      (await freezeBom(missing, ctx)).needs.some(
        (n) => n.kind === 'input' && n.path.endsWith('modelCostPerUnit'),
      ),
    ).toBe(true);
    const altered = { ...f.offers[0], versionHash: 'f'.repeat(64) };
    (ctx.assets as MemorySource).add(altered);
    expect(
      (await freezeBom(input, ctx)).needs.some(
        (n) => n.kind === 'input' && n.path.startsWith('sources.'),
      ),
    ).toBe(true);
  });
  it('quotes with injected rates, row rounding and manual final price', async () => {
    const { f, ctx, sourced } = await sourcedFixture();
    const input = { draft: sourced.draft, store: f.store, site: f.site };
    ctx.approvals = [...ctx.approvals, ...approve((await freezeBom(input, ctx)).needs)];
    const bom = (await freezeBom(input, ctx)).output!;
    const missing = await quoteBom({ bom, finalUnitPrices: {} }, ctx);
    expect(missing.output).toBeNull();
    expect(missing.needs.filter((n) => n.kind === 'param')).toHaveLength(9);
    const quoted = await quoteBom(
      { bom, finalUnitPrices: { 'sample-line': money(200) } },
      context([], {
        'bom.packRate': 0.1,
        'bom.freightFlat': 10,
        'bom.installFlat': 10,
        'bom.managementRate.custom': 0.1,
        'bom.managementRate.whole': 0.1,
        'bom.riskRate': 0.1,
        'bom.marginRate': 0.2,
        'bom.discountRate': 1,
        'bom.taxRate': 0.1,
      }),
    );
    expect(quoted.output?.cost.amount).toBe(286);
    expect(quoted.output?.sale.amount).toBe(400);
    expect(quoted.output?.tax.amount).toBe(40);
    expect(quoted.output?.profit.amount).toBe(114);
  });
});
