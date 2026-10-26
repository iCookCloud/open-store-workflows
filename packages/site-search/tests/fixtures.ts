import {
  type Approval,
  type AssetRecordOf,
  type ConditionReading,
  MemorySource,
  type SlotDef,
  type StepCtx,
  type StoreSpecBody,
  versionHash,
  type z,
} from '@osw/core';
import {
  MemoryCacheStore,
  MemoryQuotaStore,
  type SiteSearchProviders,
} from '../src/providers/types.js';
import {
  type ListingData,
  competitorQuerySlot,
  listingSlot,
  tradeAreaSlot,
} from '../src/slots/index.js';
export const NOW = '2026-01-10T12:00:00Z';
export const observed = (
  value: number | string | boolean,
  unit?: ConditionReading['measure']['unit'],
): ConditionReading['measure'] => ({
  value,
  ...(unit ? { unit } : {}),
  basis: 'observed',
  by: 'example-surveyor',
  at: '2026-01-09T12:00:00Z',
  expiresAt: '2026-12-31',
  refs: ['https://example.com/survey'],
});
export const spec: z.infer<typeof StoreSpecBody> = {
  concept: {
    storeType: 'example-noodle',
    track: 'example-noodle',
    nonFood: false,
    revenueModel: 'covers',
  },
  jurisdiction: 'XE',
  timezone: 'Etc/UTC',
  city: 'Example City',
  menu: { status: 'none', refs: [], approved: [] },
  area: { targetM2: 100, minM2: 80, maxM2: 120 },
  capacity: { seats: 20, opDays: 20 },
  staffing: [],
  economics: {
    template: { slot: 'calc-template', id: 'example', versionHash: '0'.repeat(64) },
    spend: { amount: 20, currency: 'USD' },
    taxRate: 0,
    investment: [],
    monthly: [],
    totals: {
      investment: { amount: 100000, currency: 'USD' },
      monthlyRevenue: { amount: 20000, currency: 'USD' },
      tax: { amount: 0, currency: 'USD' },
      monthlyCost: { amount: 10000, currency: 'USD' },
      monthlyProfit: { amount: 10000, currency: 'USD' },
    },
    breakeven: {
      status: 'ok',
      revenue: { amount: 20000, currency: 'USD' },
      spend: null,
      dailyUnits: null,
    },
    paybackMonths: 10,
    budgetRange: {
      low: { amount: 80000, currency: 'USD' },
      high: { amount: 120000, currency: 'USD' },
      basis: 'band',
      sampleSize: 0,
    },
    rentCeiling: { amount: 4000, currency: 'USD' },
  },
  siteRequirements: [
    {
      key: 'clearHeight',
      op: 'gte',
      value: 10,
      unit: 'ft',
      hard: true,
      basis: 'user',
      reason: 'Synthetic test requirement',
    },
  ],
  downstream: { coldchain: false, ingredients: [], equipment: [], sop: [] },
};
export function listingData(overrides: Partial<ListingData> = {}): ListingData {
  return {
    source: {
      kind: 'manual',
      name: 'Example feed',
      url: 'https://example.com/listings/one',
      sourceListingId: 'example-one',
      brokerParty: null,
    },
    status: 'active',
    address: { line1: '100 Example Road', locality: 'Example City', jurisdiction: 'XE' },
    geo: { lat: 0, lng: 0 },
    jurisdiction: 'XE',
    propertyType: 'restaurant',
    deliveryCondition: 'second_gen_food',
    area: { min: 100, max: 100, unit: 'm2' },
    askingRent: { base: { amount: 2000, currency: 'USD' }, period: 'month', basis: 'total' },
    additionalRent: 'gross',
    foodUse: 'advertised',
    restrictions: [],
    claims: [
      {
        key: 'clearHeight',
        measure: {
          ...observed(12, 'ft'),
          basis: 'claimed',
          refs: ['https://example.com/listings/one'],
        },
      },
    ],
    media: [],
    checkedAt: NOW,
    expiresAt: '2026-12-31',
    refs: ['https://example.com/listings/one'],
    ...overrides,
  };
}
export async function record<T>(slot: string, id: string, data: T): Promise<AssetRecordOf<T>> {
  return {
    slot,
    id,
    data,
    versionHash: await versionHash(data),
    slotVersion: '0.1.0',
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
    updatedAt: NOW,
    example: true,
  };
}
export const defaults: Record<string, number> = {
  'site.searchRadiusKm': 10,
  'site.screenLimit': 200,
  'site.shortlistMax': 5,
  'site.maxOccupancyRatio': 0.2,
  'site.minResidents': 10000,
  'site.evidenceMaxAgeDays': 30,
  'site.claimTolerance': 0.5,
  'site.competitorRadiusKm': 2,
  'site.maxScansPerDecision': 10,
  'places.dailyCap': 100,
  'places.reuseDays': 1,
  'listingFeed.reuseHours': 1,
  'listingFeed.maxItemsPerRun': 20,
  'listingFeed.maxChargePerRun': 0,
};
export function context(
  records: AssetRecordOf<unknown>[] = [],
  options: {
    params?: Record<string, number>;
    approvals?: Approval[];
    providers?: Partial<SiteSearchProviders>;
  } = {},
): StepCtx {
  return {
    assets: new MemorySource(records, [
      listingSlot,
      tradeAreaSlot,
      competitorQuerySlot,
    ] as SlotDef[]),
    params: {
      get: (key, at) => {
        const p = options.params ?? defaults;
        const value = p[`${key}.${at?.qualifier}`] ?? p[key];
        return value === undefined ? undefined : { value };
      },
    },
    approvals: options.approvals ?? [],
    providers: options.providers ?? {},
    now: NOW,
    actor: 'example-test',
    stores: {
      quota: new MemoryQuotaStore(() => Date.parse(NOW)),
      cache: new MemoryCacheStore(() => Date.parse(NOW)),
    },
  };
}
export async function approve(
  step: string,
  subject: string | undefined,
  value: unknown,
  decision: string,
  extra: Partial<Approval> = {},
): Promise<Approval> {
  return {
    step,
    subject,
    subjectHash: await versionHash(value),
    decision,
    by: 'example-human',
    at: NOW,
    ...extra,
  };
}
