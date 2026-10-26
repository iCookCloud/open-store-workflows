import { BudgetKey, MonthlyKey, type SlotDef, TrackKey, defineSlot, z } from '@osw/core';

export const Algorithm = z.enum(['fixed', 'area_scale', 'revenue_percent', 'subtotal_percent']);
export const CalcParam = z.object({
  key: z.union([BudgetKey, MonthlyKey]),
  kind: z.enum(['investment', 'monthly']),
  algorithm: Algorithm,
  baseValue: z.number().finite().nonnegative(),
  baseAreaM2: z.number().positive().nullable(),
  provenance: z.object({
    kind: z.enum(['actual', 'disclosure', 'estimate', 'unset']),
    storeIds: z.array(z.string()).default([]),
    note: z.string().optional(),
  }),
});
export type CalcParam = z.infer<typeof CalcParam>;

export const CalcTemplate = z
  .object({
    storeType: z.string().min(1),
    track: TrackKey,
    cuisines: z.array(z.string().min(1)),
    nonFood: z.boolean(),
    revenueModel: z.enum(['covers', 'orders']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    baseAreaM2: z.number().positive(),
    seatRatio: z.number().nonnegative().optional(),
    turnover: z.number().nonnegative().optional(),
    ordersPerDay: z.number().nonnegative().optional(),
    spend: z.number().positive(),
    taxRate: z.number().min(0).max(1),
    opDays: z.number().int().min(1).max(31),
    hasDefaults: z.boolean(),
    params: z.array(CalcParam),
    staffing: z
      .array(
        z.object({
          positionKey: z.string().min(1),
          headcount: z.number().int().nonnegative(),
          algorithm: z.enum(['fixed', 'area_scale']),
        }),
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    for (const field of value.revenueModel === 'covers'
      ? (['seatRatio', 'turnover'] as const)
      : (['ordersPerDay'] as const)) {
      if (value[field] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required for ${value.revenueModel}`,
        });
    }
    const keys = new Set<string>();
    let subtotals = 0;
    value.params.forEach((param, index) => {
      const issue = (field: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: ['params', index, field], message });
      if (keys.has(param.key)) issue('key', 'Parameter keys must be unique');
      keys.add(param.key);
      if (!(param.kind === 'investment' ? BudgetKey : MonthlyKey).safeParse(param.key).success)
        issue('key', 'Key must match its investment/monthly kind');
      if (param.algorithm === 'area_scale' && param.baseAreaM2 === null)
        issue('baseAreaM2', 'Area scaling requires a positive base area');
      if (param.algorithm === 'subtotal_percent') {
        subtotals++;
        if (param.kind !== 'investment')
          issue('algorithm', 'Subtotal percentages are investment-only');
      }
    });
    // 多个互相引用的小计百分比会形成循环，资产必须明确唯一预备金行。
    if (subtotals > 1)
      ctx.addIssue({
        code: 'custom',
        path: ['params'],
        message: 'At most one subtotal_percent line is allowed',
      });
  });
export type CalcTemplate = z.infer<typeof CalcTemplate>;
export const calcTemplateSlot: SlotDef<typeof CalcTemplate> = defineSlot({
  name: 'calc-template',
  slotVersion: '0.1.0',
  schema: CalcTemplate,
  filterable: {
    storeType: ['eq', 'in'],
    cuisines: ['hasAny'],
    track: ['eq', 'in'],
    nonFood: ['eq'],
  },
  sortable: ['storeType'],
});
export const CalcTemplateSlot = calcTemplateSlot;
