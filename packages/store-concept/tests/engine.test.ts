import { describe, expect, it } from 'vitest';
import { compute } from '../src/engine.js';
import { param, template } from './fixtures.js';

describe('deterministic economics golden cases', () => {
  it('covers revenue, rounded lines, tax and breakeven use hand-calculated values', () => {
    const actual = compute({ template: template(), areaM2: 100 });
    expect(actual.capacity).toEqual({ seats: 20, turnover: 2, opDays: 20 });
    expect(actual.totals).toEqual({
      investment: { amount: 3300, currency: 'USD' },
      monthlyRevenue: { amount: 8000, currency: 'USD' },
      tax: { amount: 800, currency: 'USD' },
      monthlyCost: { amount: 4800, currency: 'USD' },
      monthlyProfit: { amount: 3200, currency: 'USD' },
    });
    expect(actual.breakeven).toEqual({
      status: 'ok',
      revenue: { amount: 3076.92, currency: 'USD' },
      spend: { amount: 3.85, currency: 'USD' },
      dailyUnits: 15.3846,
    });
    expect(actual.paybackMonths).toBe(1.03125);
  });
  it('orders revenue always uses daily orders and turnover one', () => {
    const actual = compute({
      template: { ...template(), revenueModel: 'orders', ordersPerDay: 30 },
      areaM2: 100,
      assumptions: { turnover: 99 },
    });
    expect(actual.totals.monthlyRevenue.amount).toBe(6000);
    expect(actual.capacity).toEqual({ ordersPerDay: 30, opDays: 20 });
  });
  it('proportional costs at 100% distinguish structural loss', () => {
    const t = template();
    t.params.find((line) => line.key === 'food_cost')!.baseValue = 0.9;
    expect(compute({ template: t, areaM2: 100 }).breakeven).toEqual({ status: 'structural-loss' });
  });
  it('decimal rates totaling exactly 100% produce structural loss instead of a floating-point breakeven', () => {
    const t = template();
    t.taxRate = 0.1;
    t.params = [
      param('rent', 'monthly', 'fixed', 1000),
      param('food_cost', 'monthly', 'revenue_percent', 0.7),
      param('operating_cost', 'monthly', 'revenue_percent', 0.2),
    ] as typeof t.params;
    const actual = compute({ template: t, areaM2: 100 });
    expect(actual.proportionalRate).toBe(1);
    expect(actual.contributionRate).toBe(0);
    expect(actual.breakeven).toEqual({ status: 'structural-loss' });
  });
  it('a genuinely positive tiny decimal contribution is not rounded to structural loss', () => {
    const t = template();
    t.taxRate = 0.1;
    t.params = [
      param('rent', 'monthly', 'fixed', 1000),
      param('food_cost', 'monthly', 'revenue_percent', 0.7),
      param('operating_cost', 'monthly', 'revenue_percent', 0.1999999999999),
    ] as typeof t.params;
    const actual = compute({ template: t, areaM2: 100 });
    expect(actual.contributionRate).toBe(1e-13);
    expect(actual.breakeven).toMatchObject({ status: 'ok', revenue: { amount: 1e16 } });
  });
  it('no fixed monthly costs distinguish not-applicable', () => {
    const t = template();
    t.params = t.params.filter(
      (line) => line.kind === 'investment' || line.algorithm === 'revenue_percent',
    );
    expect(compute({ template: t, areaM2: 100 }).breakeven).toEqual({ status: 'not-applicable' });
  });
  it('an overridden proportional expense becomes a fixed amount', () => {
    const output = compute({
      template: template(),
      areaM2: 100,
      overrides: { food_cost: { amount: 1000, currency: 'USD' } },
    });
    expect(output.fixedMonthly).toBe(3000);
    expect(output.proportionalRate).toBe(0.1);
    expect(output.breakeven).toMatchObject({ status: 'ok', revenue: { amount: 3333.33 } });
    expect(output.monthly.find((line) => line.key === 'food_cost')).toMatchObject({
      amount: { amount: 1000 },
      overridden: true,
    });
  });
  it('subtotal percentages follow all other rounded investment lines', () => {
    const output = compute({ template: template(), areaM2: 200 });
    expect(output.investment.map((line) => line.amount.amount)).toEqual([4000, 1000, 500]);
    expect(output.staffing).toEqual([{ positionKey: 'example-cook', headcount: 4 }]);
  });
  it('an override of the subtotal line is final and not re-scaled', () => {
    const output = compute({
      template: template(),
      areaM2: 200,
      overrides: { working_capital: { amount: 70, currency: 'USD' } },
    });
    expect(output.totals.investment.amount).toBe(5070);
  });
  it('JPY rounds each line before summing and a loss has no payback', () => {
    const t = {
      ...template(),
      currency: 'JPY',
      params: [
        param('equipment', 'investment', 'fixed', 10.4),
        param('furnishing', 'investment', 'fixed', 10.4),
        param('rent', 'monthly', 'fixed', 20000),
      ],
    };
    const output = compute({ template: t as ReturnType<typeof template>, areaM2: 100 });
    expect(output.totals.investment.amount).toBe(20);
    expect(output.paybackMonths).toBeNull();
  });
  it('review F3: even complete expense overrides cannot turn an untrusted revenue template into payback', () => {
    const t = { ...template(), hasDefaults: false };
    const overrides = Object.fromEntries(
      t.params.map((line) => [
        line.key,
        { amount: line.key === 'working_capital' ? 0 : 100, currency: 'USD' },
      ]),
    );
    expect(() => compute({ template: t, areaM2: 100, overrides })).toThrow('trusted');
  });
  it('review F4: template-external legal investment and monthly overrides become fixed rows and enter the subtotal base', () => {
    const output = compute({
      template: template(),
      areaM2: 100,
      overrides: {
        consulting: { amount: 5000, currency: 'USD' },
        admin: { amount: 200, currency: 'USD' },
      },
    });
    expect(output.investment).toContainEqual({
      key: 'consulting',
      owner: 'store-concept',
      algorithm: 'fixed',
      overridden: true,
      amount: { amount: 5000, currency: 'USD' },
    });
    expect(output.monthly).toContainEqual({
      key: 'admin',
      algorithm: 'fixed',
      overridden: true,
      amount: { amount: 200, currency: 'USD' },
    });
    expect(output.investment.find((line) => line.key === 'working_capital')!.amount.amount).toBe(
      800,
    );
    expect(output.totals.investment.amount).toBe(8800);
    expect(output.totals.monthlyCost.amount).toBe(5000);
    expect(output.paybackMonths).toBe(8800 / 3000);
  });
  it('templates without defaults cannot invent budgets from placeholder revenue assumptions', () => {
    expect(() => compute({ template: { ...template(), hasDefaults: false }, areaM2: 100 })).toThrow(
      'trusted',
    );
  });
});
