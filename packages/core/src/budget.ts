import { type Money, roundMoney, z } from './base.js';
export const BudgetKey = z.enum([
  'consulting',
  'site_survey',
  'site_acquisition',
  'design',
  'equipment',
  'furnishing',
  'opening_inventory',
  'logistics',
  'construction',
  'compliance',
  'training',
  'promotion',
  'working_capital',
]);
export type BudgetKey = z.infer<typeof BudgetKey>;
export const MonthlyKey = z.enum([
  'rent',
  'labor',
  'utilities',
  'admin',
  'food_cost',
  'operating_cost',
]);
export type MonthlyKey = z.infer<typeof MonthlyKey>;
export const BUDGET_KEYS = {
  consulting: { owner: 'store-concept' },
  site_survey: { owner: 'site-search' },
  site_acquisition: { owner: 'site-search' },
  design: { owner: 'fitout-bom' },
  equipment: { owner: 'fitout-bom' },
  furnishing: { owner: 'fitout-bom' },
  opening_inventory: { owner: 'fitout-bom' },
  logistics: { owner: 'landed-delivery' },
  construction: { owner: 'build-out' },
  compliance: { owner: 'build-out' },
  training: { owner: 'opening' },
  promotion: { owner: 'opening' },
  working_capital: { owner: 'opening' },
} as const;
const CATEGORIES: Record<string, BudgetKey> = {
  consulting: 'consulting',
  market_research: 'consulting',
  site_survey: 'site_survey',
  broker: 'site_survey',
  lease_legal: 'site_acquisition',
  design: 'design',
  equipment: 'equipment',
  kitchen_equipment: 'equipment',
  refrigeration: 'equipment',
  pos: 'equipment',
  tableware: 'equipment',
  furniture: 'furnishing',
  lighting: 'furnishing',
  food: 'opening_inventory',
  supplies: 'opening_inventory',
  packaging: 'opening_inventory',
  logistics: 'logistics',
  freight: 'logistics',
  duty: 'logistics',
  warehouse: 'logistics',
  construction: 'construction',
  fitout: 'construction',
  signage: 'construction',
  installation: 'construction',
  compliance: 'compliance',
  training: 'training',
  promotion: 'promotion',
};
export function budgetKeyOf(category: string): BudgetKey | '' {
  return CATEGORIES[category.trim()] ?? '';
}
export function budgetVsActual(
  budget: Money,
  actual: Money,
): { budget: Money; actual: Money; delta: Money; ratio: number | null } {
  if (budget.currency !== actual.currency) throw new Error('Currency mismatch');
  return {
    budget,
    actual,
    delta: roundMoney({ amount: actual.amount - budget.amount, currency: budget.currency }),
    ratio: budget.amount === 0 ? null : actual.amount / budget.amount,
  };
}
