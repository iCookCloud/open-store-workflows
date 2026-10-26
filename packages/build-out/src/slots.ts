import { LineItem, Money, Unit, defineSlot, z } from '@osw/core';

export const InstallRate = z.object({
  match: z.object({
    lineKind: z.array(LineItem.shape.lineKind).min(1).optional(),
    category: z.array(z.string()).min(1).optional(),
    unit: z.array(Unit).min(1).optional(),
    nameContains: z.array(z.string().min(1)).optional(),
    installKind: z.enum(['fixed', 'loose', 'consumable']).optional(),
  }),
  priority: z.number().int(),
  hoursPerUnit: z.number().nonnegative(),
  unit: Unit,
  basis: z.string().min(1),
  trade: z.string().min(1).optional(),
  source: z.enum(['estimate', 'contractor-quote', 'actual-median']),
});
export const BuildFee = z
  .object({
    name: z.string().min(1),
    basis: z.enum(['pctOfGoods', 'fixed', 'perVolume']),
    pct: z.number().nonnegative().optional(),
    rate: Money.optional(),
    autoAdd: z.boolean(),
    freight: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (
      v.basis === 'pctOfGoods'
        ? v.pct === undefined || v.rate !== undefined
        : !v.rate || v.pct !== undefined
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Percentage fees require pct only; other fees require rate only',
      });
    if (v.rate && v.rate.amount < 0)
      ctx.addIssue({
        code: 'custom',
        path: ['rate', 'amount'],
        message: 'Fee rate cannot be negative',
      });
  });
export const ChecklistItem = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  ownerRole: z.string().min(1),
  dependsOn: z.array(z.string()),
  evidence: z.string(),
  gate: z.boolean(),
});
export const PhaseTemplate = z.object({
  phases: z
    .array(
      z.object({
        key: z.string().min(1),
        title: z.string().min(1),
        dependsOn: z.array(z.string()),
        trades: z.array(z.string()).optional(),
        checkpoint: z.string().optional(),
      }),
    )
    .min(1),
});
export const AcceptanceTemplate = z.object({ items: z.array(ChecklistItem).min(1) });
export const TEMPLATE_SCHEMAS = {
  'buildout-phases': PhaseTemplate,
  'buildout-acceptance': AcceptanceTemplate,
};
export const installRateSlot = defineSlot({
  name: 'install-rate',
  schema: InstallRate,
  filterable: {
    'match.unit': ['hasAny', 'exists'],
    'match.category': ['hasAny', 'exists'],
    'match.lineKind': ['hasAny', 'exists'],
  },
  sortable: ['priority'],
});
export const buildFeeSlot = defineSlot({
  name: 'build-fee',
  schema: BuildFee,
  filterable: { autoAdd: ['eq'], freight: ['eq'], basis: ['eq', 'in'] },
});
