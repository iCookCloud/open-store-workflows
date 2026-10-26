import {
  type BuildPlanBody,
  type Money,
  type Need,
  type StepCtx,
  roundMoney,
  type z,
} from '@osw/core';
import { inputNeed, scopeFor } from '../helpers.js';
import type { BuildOutInput, Estimated } from '../models.js';

export type Quote = z.infer<typeof BuildPlanBody>['quote'];
export function money(amount: number, currency: string): Money {
  return roundMoney({ amount, currency });
}

// 保留汇率换算中的精度；这里只在最终单价、行额和费用处舍入。
export function convertedAmount(
  value: Money,
  currency: string,
  ctx: StepCtx,
  input: BuildOutInput,
  needs: Need[],
  fxUsed: Record<string, number>,
) {
  if (value.currency === currency) return value.amount;
  const key = `fx.${value.currency}.${currency}`;
  const found = ctx.params.get(key, scopeFor(input));
  if (!found) {
    needs.push(
      ctx.params.need?.(key, scopeFor(input)) ?? {
        kind: 'param',
        key,
        reason: 'missing',
        blocking: true,
      },
    );
    return null;
  }
  if (typeof found.value !== 'number' || !Number.isFinite(found.value) || found.value <= 0) {
    needs.push(inputNeed(key, 'FX multiplier must be a positive finite number'));
    return null;
  }
  fxUsed[key] = found.value;
  return value.amount * found.value;
}
export function laborRate(
  ctx: StepCtx,
  input: BuildOutInput,
  needs: Need[],
  trade?: string,
): { key: string; rate: Money } | null {
  const qualified = trade ? `labor.hourlyRate.${trade}` : undefined;
  const ambiguous = qualified ? ctx.params.need?.(qualified, scopeFor(input)) : undefined;
  if (ambiguous?.kind === 'param' && ambiguous.reason === 'ambiguous') {
    needs.push(ambiguous);
    return null;
  }
  const key =
    qualified && ctx.params.get(qualified, scopeFor(input)) ? qualified : 'labor.hourlyRate';
  const value = ctx.params.get(key, scopeFor(input));
  if (!value) {
    needs.push(
      ctx.params.need?.(key, scopeFor(input)) ?? {
        kind: 'param',
        key,
        reason: 'missing',
        blocking: true,
      },
    );
    return null;
  }
  const match = /^([A-Z]{3})\/h$/.exec(value.unit ?? '');
  if (
    typeof value.value !== 'number' ||
    value.value < 0 ||
    !Number.isFinite(value.value) ||
    !match
  ) {
    needs.push(
      inputNeed(`params.${key}`, 'Labor rate requires nonnegative value and currency/hour unit'),
    );
    return null;
  }
  return { key, rate: { amount: value.value, currency: match[1] } };
}
export function priceLines(
  lines: Estimated['lines'],
  rates: Map<string, number>,
  basePrices: Map<string, number>,
  currency: string,
  selfInstall: boolean,
): Quote['lines'] {
  return lines.map((line) => {
    const rate = rates.get(line.id);
    const base = basePrices.get(line.id);
    if (rate === undefined || base === undefined)
      throw new Error(`Missing resolved price for ${line.id}`);
    const hours = selfInstall ? 0 : line.install.hoursPerUnit;
    const labor = hours * rate;
    const unitPrice = money(base + labor, currency);
    // 单价先舍入，再乘数量，不能把两个舍入点合并。
    return {
      ...line,
      unitPrice,
      laborPerUnit: money(labor, currency),
      lineTotal: money(unitPrice.amount * line.qty, currency),
    };
  });
}
export function priceFees(
  fees: Estimated['fees'],
  lines: Quote['lines'],
  goods: Money,
  currency: string,
  needs: Need[],
): Quote['fees'] {
  return fees.map((fee) => {
    let amount: number;
    if (fee.basis === 'pctOfGoods') amount = (goods.amount * (fee.pct as number)) / 100;
    else if (fee.basis === 'fixed') amount = (fee.rate as Money).amount;
    else {
      for (const line of lines)
        if (line.qty > 0 && line.volumePerUnit === undefined)
          needs.push(
            inputNeed(
              `lines.${line.id}.volumePerUnit`,
              'Per-volume fee requires a volume for every charged line',
            ),
          );
      amount =
        lines.reduce((s, l) => s + (l.volumePerUnit ?? 0) * l.qty, 0) * (fee.rate as Money).amount;
    }
    return { ...fee, amount: money(amount, currency) };
  });
}
export function totals(
  lines: Quote['lines'],
  fees: Quote['fees'],
  goods: Money,
  currency: string,
  selfInstall: boolean,
): Quote['totals'] {
  const lineAmount = money(
    lines.reduce((s, l) => s + l.lineTotal.amount, 0),
    currency,
  );
  const feeAmount = money(
    fees.reduce((s, f) => s + f.amount.amount, 0),
    currency,
  );
  return {
    goods,
    labor: money(lineAmount.amount - goods.amount, currency),
    fees: feeAmount,
    total: money(lineAmount.amount + feeAmount.amount, currency),
    laborHours: selfInstall ? 0 : lines.reduce((s, l) => s + l.qty * l.install.hoursPerUnit, 0),
  };
}
export function goodsTotal(
  lines: Quote['lines'],
  fxUsed: Record<string, number>,
  currency: string,
) {
  return money(
    lines.reduce(
      (sum, l) =>
        sum +
        money(
          money(
            l.basePrice.amount *
              (l.basePrice.currency === currency
                ? 1
                : fxUsed[`fx.${l.basePrice.currency}.${currency}`]),
            currency,
          ).amount * l.qty,
          currency,
        ).amount,
      0,
    ),
    currency,
  );
}

// 已签报价的变更沿用原单价与换算记录，不能把今天的资产价格带回旧合同。
export function repriceQuantities(
  quote: Quote,
  quantities: Map<string, number>,
  needs: Need[],
): Quote {
  const lines = quote.lines.map((line) => {
    const qty = quantities.get(line.id) ?? line.qty;
    return { ...line, qty, lineTotal: money(line.unitPrice.amount * qty, quote.currency) };
  });
  const goods = goodsTotal(lines, quote.fxUsed, quote.currency);
  const fees = priceFees(quote.fees, lines, goods, quote.currency, needs);
  return {
    ...quote,
    lines,
    fees,
    totals: totals(lines, fees, goods, quote.currency, quote.options.selfInstall),
  };
}
