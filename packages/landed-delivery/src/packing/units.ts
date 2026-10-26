import { type Money, type Need, type StepCtx, type Unit, roundMoney } from '@osw/core';
export function parseCartonUnits(spec: string): number | undefined {
  const match = spec.match(
    /(?:^|\D)(\d+)\s*(?:件|个|袋|包|pcs|pieces|packs)\s*(?:\/|per\s+)(?:箱|carton\b|case\b)/iu,
  );
  const value = match ? Number(match[1]) : undefined;
  return value && Number.isSafeInteger(value) ? value : undefined;
}
export function pieceQuantity(qty: number, unit: Unit, cartonUnits?: number): number | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (['pcs', 'set', 'pack'].includes(unit)) return qty;
  return unit === 'carton' && cartonUnits && Number.isSafeInteger(cartonUnits) && cartonUnits > 0
    ? qty * cartonUnits
    : null;
}
export function declarationValue(
  price: Money,
  quantity: number,
  target: string,
  jurisdiction: string,
  ctx: StepCtx,
  needs: Need[],
): Money | null {
  let rate = 1;
  if (price.currency !== target) {
    const key = `fx.${price.currency}.${target}`;
    const found = ctx.params.get(key, { jurisdiction });
    if (!found) {
      needs.push(
        ctx.params.need?.(key, { jurisdiction }) ?? {
          kind: 'param',
          key,
          reason: 'missing',
          blocking: true,
        },
      );
      return null;
    }
    if (
      typeof found.value !== 'number' ||
      !Number.isFinite(found.value) ||
      found.value <= 0 ||
      found.value === 1
    ) {
      needs.push({ kind: 'param', key, reason: 'ambiguous', blocking: true });
      return null;
    }
    rate = found.value;
  }
  return roundMoney({ amount: price.amount * quantity * rate, currency: target });
}
