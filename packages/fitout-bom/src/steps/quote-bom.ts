import { Money, type Need, type StepCtx, type StepDef, roundMoney, z } from '@osw/core';
import { inputNeed, numberParam, result } from '../helpers.js';
import { Bom } from './freeze-bom.js';
export const QuoteInput = z.object({
  bom: Bom,
  finalUnitPrices: z.record(z.string(), Money).default({}),
});
export const BomQuote = z.object({
  currency: z.string(),
  lines: z.array(
    z.object({ id: z.string(), suggestedUnit: Money, saleUnit: Money, saleTotal: Money }),
  ),
  direct: Money,
  pack: Money,
  freight: Money,
  install: Money,
  management: Money,
  risk: Money,
  cost: Money,
  sale: Money,
  tax: Money,
  total: Money,
  profit: Money,
  actualMargin: z.number().nullable(),
});
const keys = [
  'bom.packRate',
  'bom.freightFlat',
  'bom.installFlat',
  'bom.managementRate.custom',
  'bom.managementRate.whole',
  'bom.riskRate',
  'bom.marginRate',
  'bom.discountRate',
  'bom.taxRate',
];
export async function quoteBom(raw: z.infer<typeof QuoteInput>, ctx: StepCtx) {
  const { bom, finalUnitPrices } = QuoteInput.parse(raw);
  const needs: Need[] = [];
  const p: Record<string, number> = {};
  for (const key of keys) {
    const v = numberParam(ctx, key, needs);
    if (v !== null) {
      p[key.slice(4)] = v;
      if (v < 0 || (key === 'bom.marginRate' && v >= 1))
        needs.push(inputNeed(`params.${key}`, 'Rates must be nonnegative and margin below one'));
    }
  }
  if (needs.length) return result(null, needs);
  const currency = bom.body.currency;
  const money = (amount: number) => roundMoney({ amount, currency });
  const direct = bom.body.lines.reduce((s, l) => s + money(l.qty * l.unitPrice.amount).amount, 0);
  const whole = bom.body.lines
    .filter((l) => l.pricingMode === 'whole')
    .reduce((s, l) => s + money(l.qty * l.unitPrice.amount).amount, 0);
  const pack = money(direct * p.packRate);
  const management = money(
    (direct - whole) * p['managementRate.custom'] + whole * p['managementRate.whole'],
  );
  const risk = money(
    (direct + pack.amount + p.freightFlat + p.installFlat + management.amount) * p.riskRate,
  );
  const cost = money(
    direct + pack.amount + p.freightFlat + p.installFlat + management.amount + risk.amount,
  );
  const target = (cost.amount / (1 - p.marginRate)) * p.discountRate;
  if (direct === 0 && target !== 0)
    return result(null, [
      inputNeed('bom.lines', 'Nonzero overhead cannot be allocated to zero direct cost'),
    ]);
  for (const [id, price] of Object.entries(finalUnitPrices))
    if (!bom.body.lines.some((l) => l.id === id) || price.currency !== currency || price.amount < 0)
      needs.push(inputNeed(`finalUnitPrices.${id}`, 'Unknown line or invalid price/currency'));
  const lines = bom.body.lines.map((l) => {
    const suggestedUnit = money(direct === 0 ? 0 : (target * l.unitPrice.amount) / direct);
    const saleUnit = finalUnitPrices[l.id] ?? suggestedUnit;
    return { id: l.id, suggestedUnit, saleUnit, saleTotal: money(saleUnit.amount * l.qty) };
  });
  const sale = money(lines.reduce((s, l) => s + l.saleTotal.amount, 0));
  const tax = money(sale.amount * p.taxRate);
  const profit = money(sale.amount - cost.amount);
  return result(
    BomQuote.parse({
      currency,
      lines,
      direct: money(direct),
      pack,
      freight: money(p.freightFlat),
      install: money(p.installFlat),
      management,
      risk,
      cost,
      sale,
      tax,
      total: money(sale.amount + tax.amount),
      profit,
      actualMargin: sale.amount === 0 ? null : profit.amount / sale.amount,
    }),
    needs,
  );
}
export const quoteBomStep = {
  id: 'fitout-bom/quoteBom',
  input: QuoteInput,
  output: BomQuote,
  reads: ['params'],
  params: keys.map((key) => ({ key, required: true, description: key })),
  run: quoteBom,
} satisfies StepDef<typeof QuoteInput, typeof BomQuote>;
