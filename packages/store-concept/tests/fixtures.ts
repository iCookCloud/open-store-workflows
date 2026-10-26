import {
  type AnyAssetRecord,
  MemorySource,
  SHARED_SLOTS,
  type StepCtx,
  createParamReader,
  versionHash,
} from '@osw/core';
import type { ConceptBrief } from '../src/brief.js';
import { type CalcTemplate, calcTemplateSlot } from '../src/slots/calc-template.js';
import { siteProfileSlot } from '../src/slots/site-profile.js';

export const now = '2026-01-02T12:00:00Z';
export const brief: ConceptBrief = {
  storeId: null,
  storeType: 'example-noodle',
  cuisine: 'example-noodle',
  jurisdiction: 'XE',
  timezone: 'UTC',
  areaM2: 100,
  currency: 'USD',
};
export const param = (
  key: string,
  kind: 'investment' | 'monthly',
  algorithm: 'fixed' | 'area_scale' | 'revenue_percent' | 'subtotal_percent',
  baseValue: number,
  baseAreaM2: number | null = null,
) => ({
  key,
  kind,
  algorithm,
  baseValue,
  baseAreaM2,
  provenance: { kind: 'actual' as const, storeIds: [] as string[] },
});
export function template(): CalcTemplate {
  return {
    storeType: 'example-noodle',
    track: 'example-noodle',
    cuisines: ['example-noodle'],
    nonFood: false,
    revenueModel: 'covers',
    currency: 'USD',
    baseAreaM2: 100,
    seatRatio: 0.2,
    turnover: 2,
    spend: 10,
    taxRate: 0.1,
    opDays: 20,
    hasDefaults: true,
    params: [
      param('equipment', 'investment', 'area_scale', 2000, 100),
      param('furnishing', 'investment', 'fixed', 1000),
      param('working_capital', 'investment', 'subtotal_percent', 0.1),
      param('rent', 'monthly', 'fixed', 1000),
      param('labor', 'monthly', 'fixed', 1000),
      param('food_cost', 'monthly', 'revenue_percent', 0.25),
    ] as CalcTemplate['params'],
    staffing: [{ positionKey: 'example-cook', headcount: 2, algorithm: 'area_scale' }],
  };
}
export async function record(
  slot: string,
  id: string,
  data: unknown,
  jurisdictions: string[] = [],
): Promise<AnyAssetRecord> {
  return {
    slot,
    id,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions },
    updatedAt: now,
    example: true,
    data,
  };
}
export async function fixture(
  options: { template?: CalcTemplate; stores?: number; menus?: boolean } = {},
) {
  const records = [
    await record('calc-template', 'example-template', options.template ?? template()),
    await record('site-profile', 'example-profile', {
      storeType: 'example-noodle',
      requirements: [
        {
          key: 'clearHeight',
          op: 'gte',
          value: 3,
          unit: 'm',
          hard: true,
          reason: 'Example ceiling height',
        },
      ],
      equipmentTriggers: [
        {
          termKeys: ['example-hood'],
          requirement: {
            key: 'exhaustPath',
            op: 'in',
            value: ['existing', 'feasible'],
            hard: true,
            reason: 'Hood needs exhaust',
          },
        },
      ],
    }),
    await record('term', 'hood-id', {
      key: 'example-hood',
      kind: 'equipment',
      labels: { en: 'Example hood' },
    }),
  ];
  if (options.menus !== false)
    records.push(
      await record('menu', 'example-menu', {
        title: { en: 'Example menu' },
        cuisine: 'example-noodle',
        tracks: ['example-noodle'],
        origin: 'delivered',
        pageCount: 2,
        derives: {
          ingredients: [{ key: 'example-flour' }],
          equipment: [{ key: 'example-hood' }],
          sop: [{ key: 'example-prep' }],
          coldchain: false,
        },
      }),
    );
  for (const [key, value] of Object.entries({
    'concept.budgetBand': 0.2,
    'concept.areaTolerance': 0.1,
    'concept.minMarginRate': 0.1,
    'concept.calibrationMinSample': 2,
    'verify.calcTemplateTolerance': 0.15,
  }))
    records.push(await record('params', key, { key, value }));
  for (let index = 0; index < (options.stores ?? 0); index++)
    records.push(
      await record('store', `example-store-${index}`, {
        name: { en: `Example store ${index}` },
        status: 'operating',
        track: 'example-noodle',
        storeType: 'example-noodle',
        jurisdiction: 'XE',
        timezone: 'UTC',
        areaM2: 100,
        actuals: [
          {
            key: 'equipment',
            amount: { amount: 2000 + 1000 * index, currency: 'USD' },
            basis: 'paid',
            at: now,
          },
          { key: 'furnishing', amount: { amount: 1000, currency: 'USD' }, basis: 'paid', at: now },
          {
            key: 'working_capital',
            amount: { amount: 300, currency: 'USD' },
            basis: 'paid',
            at: now,
          },
        ],
      }),
    );
  const source = new MemorySource(records, [...SHARED_SLOTS, calcTemplateSlot, siteProfileSlot]);
  const ctx: StepCtx = {
    assets: source,
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      now,
    ),
    approvals: [],
    providers: {},
    now,
    actor: 'example:test',
  };
  return { source, ctx, records };
}
