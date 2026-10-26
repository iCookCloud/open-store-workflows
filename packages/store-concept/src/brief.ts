import { ArtifactRef, AssetId, BudgetKey, Jurisdiction, Money, MonthlyKey, z } from '@osw/core';

export const ConceptBrief = z
  .object({
    storeId: AssetId.nullable(),
    storeType: z.string().min(1).optional(),
    cuisine: z.string().min(1).optional(),
    jurisdiction: Jurisdiction,
    city: z.string().min(1).optional(),
    timezone: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Expected an IANA time zone'),
    areaM2: z.number().positive().optional(),
    budgetCap: Money.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    overrides: z.partialRecord(z.union([BudgetKey, MonthlyKey]), Money).optional(),
    assumptions: z
      .object({
        spend: Money.optional(),
        turnover: z.number().nonnegative().optional(),
        opDays: z.number().int().min(1).max(31).optional(),
      })
      .optional(),
    inputs: z.array(ArtifactRef).optional(),
    supersedes: ArtifactRef.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.storeType && !value.cuisine)
      ctx.addIssue({ code: 'custom', path: ['storeType'], message: 'Supply storeType or cuisine' });
    const check = (money: z.infer<typeof Money> | undefined, path: (string | number)[]) => {
      if (money && money.currency !== value.currency)
        ctx.addIssue({ code: 'custom', path, message: 'Currency must match brief.currency' });
      if (money && money.amount < 0)
        ctx.addIssue({ code: 'custom', path, message: 'Amount cannot be negative' });
    };
    check(value.budgetCap, ['budgetCap']);
    check(value.assumptions?.spend, ['assumptions', 'spend']);
    if (value.assumptions?.spend?.amount === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['assumptions', 'spend'],
        message: 'Spend must be positive',
      });
    for (const [key, money] of Object.entries(value.overrides ?? {}))
      check(money, ['overrides', key]);
  });
export type ConceptBrief = z.infer<typeof ConceptBrief>;
