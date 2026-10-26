import { type Money, type Need, type StepCtx, convertUnit, roundMoney } from '@osw/core';
import type { StoreSpecBody, z } from '@osw/core';
import type { ListingData } from '../slots/listing.js';
import { type Check, inputNeed, numberParam } from './common.js';
export interface RentAssessment {
  monthlyBase: Money | null;
  monthlyTotal: Money | null;
  occupancyRatio: number | null;
  checks: Check[];
  needs: Need[];
}
export function moneyIn(value: Money, currency: string, ctx: StepCtx, needs: Need[]): Money | null {
  if (value.currency === currency) return roundMoney(value);
  const rate = numberParam(ctx, `fx.${value.currency}.${currency}`, needs, undefined, false);
  if (rate === undefined || rate <= 0) return null;
  return roundMoney({ amount: value.amount * rate, currency });
}
export function monthlyRent(rent: NonNullable<ListingData['askingRent']>, areaM2: number): Money {
  const factor = rent.basis === 'per_area' ? convertUnit(areaM2, 'm2', rent.areaUnit!).value! : 1;
  return roundMoney({
    amount: (rent.base.amount * factor) / (rent.period === 'year' ? 12 : 1),
    currency: rent.base.currency,
  });
}
export function assessRent(
  listing: ListingData,
  spec: z.infer<typeof StoreSpecBody>,
  ctx: StepCtx,
  additional?: Money,
): RentAssessment {
  const needs: Need[] = [];
  const checks: Check[] = [];
  const currency = spec.economics.spend.currency;
  const monthlyBase = listing.askingRent
    ? moneyIn(monthlyRent(listing.askingRent, spec.area.targetM2), currency, ctx, needs)
    : null;
  const fees = additional
    ? moneyIn(additional, currency, ctx, needs)
    : listing.additionalRent === 'gross'
      ? { amount: 0, currency }
      : null;
  const monthlyTotal =
    monthlyBase && fees ? roundMoney({ amount: monthlyBase.amount + fees.amount, currency }) : null;
  if (additional && additional.amount < 0)
    needs.push(inputNeed('additional', 'Additional rent cannot be negative', false));
  const ceiling = spec.economics.rentCeiling;
  const limit = numberParam(
    ctx,
    'site.maxOccupancyRatio',
    needs,
    { jurisdiction: spec.jurisdiction, track: spec.concept.track },
    false,
  );
  const revenue =
    spec.economics.breakeven.status === 'ok' ? spec.economics.breakeven.revenue : null;
  const occupancyRatio =
    monthlyTotal && revenue && revenue.amount > 0 ? monthlyTotal.amount / revenue.amount : null;
  checks.push({
    key: 'rent',
    hard: true,
    verdict:
      !monthlyTotal || !ceiling || needs.some((n) => n.kind === 'input')
        ? 'pending'
        : monthlyTotal.amount <= ceiling.amount
          ? 'holds'
          : 'fails',
    reason: !monthlyTotal
      ? 'Base rent or additional charges are unknown'
      : !ceiling
        ? 'Rent ceiling is missing'
        : 'Compared total occupancy cost with monthly rent ceiling',
  });
  checks.push({
    key: 'occupancyRatio',
    hard: true,
    verdict:
      occupancyRatio === null || limit === undefined
        ? 'pending'
        : occupancyRatio <= limit
          ? 'holds'
          : 'fails',
    reason: 'Total monthly occupancy cost / breakeven revenue',
  });
  return { monthlyBase, monthlyTotal, occupancyRatio, checks, needs };
}
