import { AssetRef, Jurisdiction, Money, TermRef, TrackKey, WorkflowKey, z } from '../base.js';
import { BudgetKey, MonthlyKey } from '../budget.js';
import { Requirement } from '../conditions.js';
import { ArtifactRef } from './envelope.js';
export const SpecRequirement = Requirement.extend({
  basis: z.enum(['store-type', 'menu', 'estimate', 'user']),
  reason: z.string(),
  source: AssetRef.optional(),
});
const Line = z.object({
  amount: Money,
  algorithm: z.enum(['fixed', 'area_scale', 'revenue_percent', 'subtotal_percent']),
  overridden: z.boolean(),
});
export const StoreSpecBody = z
  .object({
    supersedes: ArtifactRef.optional(),
    concept: z.object({
      storeType: z.string(),
      track: TrackKey,
      cuisine: z.string().optional(),
      nonFood: z.boolean(),
      revenueModel: z.enum(['covers', 'orders']),
    }),
    jurisdiction: Jurisdiction,
    city: z.string().optional(),
    timezone: z.string().min(1),
    menu: z.object({
      status: z.enum(['not-applicable', 'none', 'candidate', 'approved']),
      refs: z.array(
        z.object({
          ref: AssetRef,
          status: z.enum(['candidate', 'adapting', 'approved', 'dropped']),
          note: z.string().optional(),
        }),
      ),
      approved: z.array(AssetRef),
    }),
    area: z.object({
      targetM2: z.number().positive(),
      minM2: z.number().positive(),
      maxM2: z.number().positive(),
    }),
    capacity: z.object({
      seats: z.number().int().nonnegative().optional(),
      ordersPerDay: z.number().nonnegative().optional(),
      turnover: z.number().nonnegative().optional(),
      opDays: z.number().int().min(1).max(31),
    }),
    staffing: z.array(
      z.object({ positionKey: z.string(), headcount: z.number().int().nonnegative() }),
    ),
    economics: z.object({
      template: AssetRef,
      spend: Money,
      taxRate: z.number().min(0).max(1),
      investment: z.array(
        Line.extend({
          key: BudgetKey,
          owner: WorkflowKey,
          range: z.object({ low: Money, high: Money }).optional(),
        }),
      ),
      monthly: z.array(Line.extend({ key: MonthlyKey })),
      totals: z.object({
        investment: Money,
        monthlyRevenue: Money,
        tax: Money,
        monthlyCost: Money,
        monthlyProfit: Money,
      }),
      breakeven: z.discriminatedUnion('status', [
        z.object({
          status: z.literal('ok'),
          revenue: Money,
          spend: Money.nullable(),
          dailyUnits: z.number().nullable(),
        }),
        z.object({ status: z.literal('structural-loss') }),
        z.object({ status: z.literal('not-applicable') }),
      ]),
      paybackMonths: z.number().nullable(),
      budgetRange: z.object({
        low: Money,
        high: Money,
        basis: z.enum(['band', 'actuals']),
        sampleSize: z.number().int(),
      }),
      rentCeiling: Money.nullable(),
    }),
    siteRequirements: z.array(SpecRequirement),
    downstream: z.object({
      coldchain: z.boolean().nullable(),
      ingredients: z.array(TermRef),
      equipment: z.array(TermRef),
      sop: z.array(TermRef),
    }),
  })
  .superRefine((v, ctx) => {
    if (v.area.minM2 > v.area.targetM2 || v.area.targetM2 > v.area.maxM2)
      ctx.addIssue({ code: 'custom', message: 'Invalid area interval', path: ['area'] });
    const currency = v.economics.spend.currency;
    const walk = (x: unknown, path: (string | number)[]) => {
      if (!x || typeof x !== 'object') return;
      const o = x as Record<string, unknown>;
      if ('amount' in o && typeof o.currency === 'string' && o.currency !== currency)
        ctx.addIssue({ code: 'custom', message: 'Currency mismatch', path });
      for (const [k, val] of Object.entries(o)) walk(val, [...path, k]);
    };
    walk(v.economics, ['economics']);
  });
export type StoreSpecBody = z.infer<typeof StoreSpecBody>;
