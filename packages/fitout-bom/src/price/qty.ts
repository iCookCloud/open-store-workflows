import type { BomLine } from '@osw/core';
export interface SiteMetrics {
  seats?: number;
  area?: number;
  frontage?: number;
  clearHeight?: number;
}
export class QuantityError extends Error {
  constructor(
    readonly lineId: string,
    message: string,
  ) {
    super(message);
  }
}
export function resolveQuantities(
  lines: readonly BomLine[],
  metrics: SiteMetrics = {},
): Map<string, number> {
  const byId = new Map(lines.map((l) => [l.id, l]));
  if (byId.size !== lines.length) throw new QuantityError('lines', 'Duplicate line IDs');
  const values = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (id: string): number => {
    const known = values.get(id);
    if (known !== undefined) return known;
    const line = byId.get(id);
    if (!line) throw new QuantityError(id, 'Linked line does not exist');
    if (visiting.has(id)) throw new QuantityError(id, 'Quantity dependency cycle');
    visiting.add(id);
    const r = line.qtyRule;
    let value = line.qty;
    if (r.kind === 'length' || r.kind === 'area') value = r.demand * (1 + r.lossPct);
    else if (r.kind === 'modules' || r.kind === 'tiles') {
      const d = line.dimensionsMm;
      const coverage =
        r.kind === 'modules' ? (d?.l ?? 0) / 1000 : ((d?.l ?? 0) * (d?.w ?? 0)) / 1e6;
      if (coverage <= 0) throw new QuantityError(id, 'Positive module dimensions are required');
      value = Math.ceil((r.demand * (1 + r.lossPct)) / coverage / r.packSize - 1e-10) * r.packSize;
    } else if (r.kind === 'linked')
      value = r.links.reduce((sum, ref) => sum + resolve(ref), 0) * r.factor;
    else if (r.kind === 'site') {
      const metric = metrics[r.metric];
      if (metric === undefined) throw new QuantityError(id, `Missing site metric ${r.metric}`);
      value = metric * r.factor * (1 + r.lossPct);
      if (['pcs', 'set', 'pack', 'carton', 'lot'].includes(line.unit))
        value = Math.ceil(value - 1e-10);
    }
    if (!Number.isFinite(value) || value < 0 || value > 1e8)
      throw new QuantityError(id, 'Quantity must be between zero and 100000000');
    visiting.delete(id);
    values.set(id, value);
    return value;
  };
  for (const line of lines) resolve(line.id);
  return values;
}
