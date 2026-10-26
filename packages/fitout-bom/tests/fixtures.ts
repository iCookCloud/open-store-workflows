import {
  type AnyAssetRecord,
  type Approval,
  type AssetRecordOf,
  type BomLine,
  MemorySource,
  OfferSlot,
  PartySlot,
  ProductSlot,
  SiteDecisionBody,
  type SlotDef,
  type StepCtx,
  StoreSpecBody,
  TemplateSlot,
  assetRef,
  fieldsetHash,
  versionHash,
  type z,
} from '@osw/core';
import type { BomDraft } from '../src/schema.js';
export const now = '2026-01-01T12:00:00Z';
export const money = (amount: number, currency = 'USD') => ({ amount, currency });
export async function record<S extends z.ZodObject>(
  slot: SlotDef<S>,
  id: string,
  data: z.infer<S>,
): Promise<AssetRecordOf<z.infer<S>>> {
  const parsed = slot.schema.parse(data);
  const fieldsets: Record<string, string> = {};
  for (const [key, fields] of Object.entries(slot.fieldsets ?? {}))
    fieldsets[key] = await fieldsetHash(parsed, fields);
  return {
    slot: slot.name,
    id,
    slotVersion: slot.slotVersion,
    versionHash: await versionHash(parsed),
    fieldsetHashes: fieldsets,
    coverage: { tier: 'general', tracks: [], jurisdictions: [], workflows: [] },
    updatedAt: now,
    example: true,
    data: parsed,
  };
}
export function context(
  records: AnyAssetRecord[] = [],
  params: Record<string, number> = {},
  approvals: Approval[] = [],
): StepCtx {
  const defaults = {
    'bom.offerBand.low': 0.8,
    'bom.offerBand.high': 1.2,
    'bom.specTolerance': 10,
    'bom.rateCheckMinOffers': 2,
    'site.powerDiversity': 1,
    ...params,
  };
  return {
    assets: new MemorySource(records),
    params: {
      get: (key, scope) => {
        const value =
          defaults[`${key}.${scope?.qualifier}` as keyof typeof defaults] ??
          defaults[key as keyof typeof defaults];
        return value === undefined ? undefined : { value };
      },
    },
    providers: {},
    approvals,
    now,
    actor: 'osw:fitout-bom/test@0.1.0',
  };
}
export function line(patch: Partial<BomLine> = {}): BomLine {
  return {
    id: 'sample-line',
    lineKind: 'furniture',
    qty: 2,
    unit: 'pcs',
    category: 'furniture.table',
    name: 'Example Table',
    zone: 'Dining',
    spec: 'Synthetic table',
    qtyRule: { kind: 'manual' },
    qtyBasis: { status: 'manual', note: 'Synthetic fixture' },
    dimsBasis: { status: 'manual', note: 'Synthetic fixture' },
    budgetKey: 'furnishing',
    evidence: [],
    derivedFrom: { kind: 'manual', ref: 'example' },
    pricingMode: 'custom',
    components: [
      {
        key: 'top',
        name: 'Example top',
        kind: 'material',
        basis: 'fixed',
        qtyPerUnit: 1,
        unit: 'm2',
        rate: money(100),
        rateNote: 'Synthetic fixture',
      },
    ],
    modelCostPerUnit: null,
    parts: [],
    modelWarnings: [],
    sourcing: null,
    costBasis: 'model',
    unitPrice: { ...money(0), basis: 'estimate' },
    ...patch,
  };
}
export function draft(lines: BomLine[] = [line()]): BomDraft {
  return {
    currency: 'USD',
    storeId: 'example-store',
    lines,
    sources: [],
    inputs: [],
    example: true,
  };
}
export function approve(
  needs: { kind: string; step?: string; subject?: string; subjectHash?: string }[],
  decision = 'approve',
): Approval[] {
  return needs
    .filter((n) => n.kind === 'approval')
    .map((n) => ({
      step: n.step!,
      subject: n.subject,
      subjectHash: n.subjectHash!,
      decision,
      by: 'example-reviewer',
      at: now,
    }));
}
export async function fixture() {
  const product = await record(ProductSlot, 'example-product', {
    name: { en: 'Example Table' },
    kind: 'catalog',
    category: 'furniture.table',
    goodsClass: 'nonfood',
    status: 'active',
  });
  const party = await record(PartySlot, 'example-supplier', {
    name: { en: 'Example Supplier' },
    roles: ['supplier'],
    status: 'active',
  });
  const makeOffer = (
    id: string,
    amount: number,
    includes: ('pack' | 'freight' | 'install' | 'tax')[] = [],
  ) =>
    record(OfferSlot, id, {
      productId: product.id,
      partyId: party.id,
      basis: 'quote',
      use: 'project',
      currency: 'USD',
      unit: 'pcs',
      tiers: [{ minQty: 0, unitPrice: amount }],
      quotedAt: '2026-01-01',
      validUntil: '2026-12-31',
      includes,
      leadTimeDays: { min: 2, max: 5 },
    });
  const offers = await Promise.all([
    makeOffer('example-holds', 100),
    makeOffer('example-fails', 200),
    makeOffer('example-pending', 110, ['freight']),
  ]);
  const template = await record(TemplateSlot, 'example-budget', {
    kind: 'economics',
    lang: 'en',
    title: { en: 'Example Budget' },
    format: 'json',
    content: { example: true },
  });
  const storeBody = StoreSpecBody.parse({
    concept: {
      storeType: 'example-retail',
      track: 'example',
      nonFood: true,
      revenueModel: 'orders',
    },
    jurisdiction: 'XE',
    timezone: 'UTC',
    menu: { status: 'not-applicable', refs: [], approved: [] },
    area: { targetM2: 100, minM2: 50, maxM2: 200 },
    capacity: { seats: 10, opDays: 20 },
    staffing: [],
    economics: {
      template: assetRef(template),
      spend: money(10),
      taxRate: 0,
      investment: [
        {
          key: 'furnishing',
          owner: 'fitout-bom',
          amount: money(300),
          algorithm: 'fixed',
          overridden: false,
          range: { low: money(100), high: money(300) },
        },
      ],
      monthly: [],
      totals: {
        investment: money(300),
        monthlyRevenue: money(1000),
        tax: money(0),
        monthlyCost: money(500),
        monthlyProfit: money(500),
      },
      breakeven: { status: 'not-applicable' },
      paybackMonths: 1,
      budgetRange: { low: money(100), high: money(1000), basis: 'band', sampleSize: 0 },
      rentCeiling: money(100),
    },
    siteRequirements: [],
    downstream: { coldchain: false, ingredients: [], equipment: [], sop: [] },
  });
  const siteBody = SiteDecisionBody.parse({
    stage: 'chosen',
    listing: { slot: 'listing', id: 'example-listing', versionHash: '0'.repeat(64) },
    address: { line1: 'Example Road', locality: 'Example City', jurisdiction: 'XE' },
    geo: { lat: 0, lng: 0 },
    jurisdiction: 'XE',
    unit: 'Example unit',
    floorLevel: 1,
    conditions: [
      { key: 'area', measure: { value: 100, unit: 'm2' }, verdict: 'holds' },
      { key: 'clearHeight', measure: { value: 3, unit: 'm' }, verdict: 'holds' },
    ],
    unmeasured: [],
    openingTarget: '2026-02-01',
    lease: null,
    shortlist: [
      {
        listing: { slot: 'listing', id: 'example-listing', versionHash: '0'.repeat(64) },
        status: 'chosen',
        reason: 'Synthetic selection',
      },
    ],
  });
  const envelope = async <K extends 'StoreSpec' | 'SiteDecision', B>(kind: K, body: B) => ({
    kind,
    artifactVersion: '0.1.0',
    id: `example-${kind}`,
    hash: await versionHash(body),
    producedBy: {
      step: kind === 'StoreSpec' ? 'store-concept/freezeSpec' : 'site-search/freezeSite',
      pkg: '@osw/example',
      pkgVersion: '0.1.0',
    },
    storeId: 'example-store',
    inputs: [],
    sources: [],
    createdAt: now,
    example: true as const,
    body,
  });
  return {
    product,
    party,
    offers,
    template,
    records: [product, party, ...offers, template],
    store: await envelope('StoreSpec', storeBody),
    site: await envelope('SiteDecision', siteBody),
    draft: draft([line({ productRef: assetRef(product) })]),
  };
}
