import { BUDGET_KEYS, BudgetKey, Money, MonthlyKey, StoreSpecBody, roundMoney, z } from '@osw/core';
import type { ConceptBrief } from './brief.js';
import { decimalSum } from './decimal.js';
import { type CalcParam, CalcTemplate } from './slots/calc-template.js';

const EconomicsShape = StoreSpecBody.shape.economics;
export const EngineOutput = EconomicsShape.omit({
  template: true,
  budgetRange: true,
  rentCeiling: true,
}).extend({
  capacity: StoreSpecBody.shape.capacity,
  staffing: StoreSpecBody.shape.staffing,
  fixedMonthly: z.number(),
  proportionalRate: z.number(),
  contributionRate: z.number(),
});
export type EngineOutput = z.infer<typeof EngineOutput>;
export interface ComputeInput {
  template: CalcTemplate;
  areaM2: number;
  overrides?: ConceptBrief['overrides'];
  assumptions?: ConceptBrief['assumptions'];
}

export function paramValue(
  param: CalcParam,
  areaM2: number,
  revenue: number,
  subtotal = 0,
): number {
  switch (param.algorithm) {
    case 'fixed':
      return param.baseValue;
    case 'area_scale': {
      if (param.baseAreaM2 === null || param.baseAreaM2 <= 0)
        throw new Error('Area scaling requires baseAreaM2 > 0');
      return (param.baseValue * areaM2) / param.baseAreaM2;
    }
    case 'revenue_percent':
      return revenue * param.baseValue;
    case 'subtotal_percent':
      return subtotal * param.baseValue;
  }
}

export function compute(input: ComputeInput): EngineOutput {
  const template = CalcTemplate.parse(input.template);
  if (!Number.isFinite(input.areaM2) || input.areaM2 <= 0)
    throw new Error('areaM2 must be positive');
  const { overrides = {}, assumptions = {} } = input;
  for (const money of [
    ...Object.values(overrides),
    ...(assumptions.spend ? [assumptions.spend] : []),
  ]) {
    Money.parse(money);
    if (money.amount < 0) throw new Error('Overrides and spend cannot be negative');
    if (money.currency !== template.currency)
      throw new Error('All money must match template.currency before compute');
  }
  if (!template.hasDefaults)
    throw new Error('A trusted template is required before computing financial outputs');
  const parameters: CalcParam[] = [...template.params];
  const existing = new Set(parameters.map((param) => param.key));
  for (const key of Object.keys(overrides).sort()) {
    const investmentKey = BudgetKey.safeParse(key);
    const monthlyKey = MonthlyKey.safeParse(key);
    if (!investmentKey.success && !monthlyKey.success)
      throw new Error(`Unknown override key: ${key}`);
    const parsedKey = investmentKey.success ? investmentKey.data : monthlyKey.data!;
    if (existing.has(parsedKey)) continue;
    // 模板外的用户金额也是有效预算，固定追加后参与小计与保本计算。
    parameters.push({
      key: parsedKey,
      kind: investmentKey.success ? 'investment' : 'monthly',
      algorithm: 'fixed',
      baseValue: overrides[parsedKey]!.amount,
      baseAreaM2: null,
      provenance: { kind: 'unset', storeIds: [] },
    });
  }
  const money = (amount: number) => roundMoney({ amount, currency: template.currency });
  const spend = money(assumptions.spend?.amount ?? template.spend);
  if (spend.amount <= 0) throw new Error('Spend must be positive after rounding');
  const orders = template.revenueModel === 'orders';
  const seats = orders ? template.ordersPerDay! : Math.round(input.areaM2 * template.seatRatio!);
  const turnover = orders ? 1 : (assumptions.turnover ?? template.turnover!);
  const opDays = assumptions.opDays ?? template.opDays;
  if (
    !Number.isFinite(turnover) ||
    turnover < 0 ||
    !Number.isInteger(opDays) ||
    opDays < 1 ||
    opDays > 31
  )
    throw new Error('Invalid operating assumptions');
  const monthlyRevenue = money(seats * turnover * spend.amount * opDays);
  const overridden = (param: CalcParam) => overrides[param.key] !== undefined;
  const amountFor = (param: CalcParam, subtotal = 0) =>
    money(
      overrides[param.key]?.amount ??
        paramValue(param, input.areaM2, monthlyRevenue.amount, subtotal),
    );
  const investmentParams = parameters.filter((param) => param.kind === 'investment');
  const subtotal = investmentParams
    .filter((param) => param.algorithm !== 'subtotal_percent')
    .reduce((sum, param) => sum + amountFor(param).amount, 0);
  const investment = investmentParams
    .map((param) => ({
      key: param.key as z.infer<typeof StoreSpecBody>['economics']['investment'][number]['key'],
      owner: BUDGET_KEYS[param.key as keyof typeof BUDGET_KEYS].owner,
      amount: amountFor(param, subtotal),
      algorithm: param.algorithm,
      overridden: overridden(param),
    }))
    .filter((line) => line.amount.amount > 0);
  const monthlyParams = parameters.filter((param) => param.kind === 'monthly');
  const monthly = monthlyParams.map((param) => ({
    key: param.key as z.infer<typeof StoreSpecBody>['economics']['monthly'][number]['key'],
    amount: amountFor(param),
    algorithm: param.algorithm,
    overridden: overridden(param),
  }));
  const totalInvestment = money(investment.reduce((sum, line) => sum + line.amount.amount, 0));
  const tax = money(monthlyRevenue.amount * template.taxRate);
  const monthlyCost = money(
    monthly.reduce((sum, line) => sum + line.amount.amount, 0) + tax.amount,
  );
  const monthlyProfit = money(monthlyRevenue.amount - monthlyCost.amount);
  const rates = [
    template.taxRate,
    ...monthlyParams
      .filter((param) => param.algorithm === 'revenue_percent' && !overridden(param))
      .map((param) => param.baseValue),
  ];
  const proportionalRate = decimalSum(rates);
  const contributionRate = decimalSum([1, ...rates.map((rate) => -rate)]);
  const fixedMonthly = monthlyParams
    .filter((param) => param.algorithm !== 'revenue_percent' || overridden(param))
    .reduce((sum, param) => sum + amountFor(param).amount, 0);
  const denom = contributionRate;
  const revenue = denom > 0 && fixedMonthly > 0 ? money(fixedMonthly / denom) : null;
  const perSpend = seats * turnover * opDays;
  const breakeven =
    denom <= 0
      ? { status: 'structural-loss' as const }
      : fixedMonthly <= 0
        ? { status: 'not-applicable' as const }
        : {
            status: 'ok' as const,
            revenue: revenue!,
            spend: perSpend > 0 ? money(revenue!.amount / perSpend) : null,
            dailyUnits: revenue!.amount / spend.amount / opDays,
          };
  return EngineOutput.parse({
    spend,
    taxRate: template.taxRate,
    investment,
    monthly,
    totals: { investment: totalInvestment, monthlyRevenue, tax, monthlyCost, monthlyProfit },
    breakeven,
    paybackMonths: monthlyProfit.amount > 0 ? totalInvestment.amount / monthlyProfit.amount : null,
    capacity: { ...(orders ? { ordersPerDay: seats } : { seats, turnover }), opDays },
    staffing: (template.staffing ?? []).map((line) => ({
      positionKey: line.positionKey,
      headcount:
        line.algorithm === 'area_scale'
          ? Math.ceil((line.headcount * input.areaM2) / template.baseAreaM2)
          : line.headcount,
    })),
    fixedMonthly,
    proportionalRate,
    contributionRate,
  });
}
