import { z } from 'zod';
export { z };
export const WorkflowKey = z.enum([
  'store-concept',
  'site-search',
  'fitout-bom',
  'landed-delivery',
  'build-out',
  'opening',
  'replenishment',
]);
export type WorkflowKey = z.infer<typeof WorkflowKey>;
export const StepId = z.string().regex(/^[a-z][a-z-]*\/[a-z][a-zA-Z0-9]{0,47}$/);
export const SlotName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const Hash = z.string().regex(/^[0-9a-f]{64}$/);
export const AssetId = z
  .string()
  .min(1)
  .max(256)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 资产 ID 明确拒绝控制字符
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);
export const Lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
export const TrackKey = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const LocalizedText = z
  .record(Lang, z.string().min(1))
  .refine((v) => Object.keys(v).length > 0);
export const Jurisdiction = z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3}(-[A-Z0-9]{2,12})?)?$/);
export const AssetRef = z.object({
  slot: SlotName,
  id: AssetId,
  versionHash: Hash,
  fieldset: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,31}$/)
    .optional(),
  path: z.string().optional(),
});
export type AssetRef = z.infer<typeof AssetRef>;
export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Currency = z.string().regex(/^[A-Z]{3}$/);
export const Money = z.object({ amount: z.number().finite(), currency: Currency });
export type Money = z.infer<typeof Money>;
export const Unit = z.enum([
  'pcs',
  'set',
  'pack',
  'carton',
  'kg',
  'g',
  'L',
  'ml',
  'm',
  'cm',
  'mm',
  'in',
  'ft',
  'm2',
  'ft2',
  'm3',
  'h',
  'day',
  'month',
  'kW',
  'kVA',
  'A',
  'V',
  'm3/h',
  'gal',
  'BTU/h',
  'lot',
]);
export type Unit = z.infer<typeof Unit>;
export const Measure = z.object({
  value: z.union([z.number().finite(), z.string(), z.boolean()]),
  unit: Unit.optional(),
  at: IsoDateTime.optional(),
  by: z.string().optional(),
  basis: z.enum(['observed', 'claimed', 'quote', 'estimate']).optional(),
  expiresAt: IsoDate.optional(),
  refs: z.array(z.string()).optional(),
});
export type Measure = z.infer<typeof Measure>;
export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export const Quantity = z.object({ value: z.number().nonnegative(), unit: Unit });
export const Address = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  locality: z.string(),
  postalCode: z.string().optional(),
  jurisdiction: Jurisdiction,
});
export const TermRef = z.object({ key: z.string(), label: z.string().optional() });
export const LineItem = z.object({
  id: z.string().min(1),
  lineKind: z.enum(['furniture', 'equipment', 'fitout', 'supplies', 'food']),
  productRef: AssetRef.optional(),
  offerRef: AssetRef.optional(),
  qty: z.number().nonnegative(),
  unit: Unit,
});
export const FillSrc = z.enum(['asset', 'manual', 'estimate', 'derived', 'history']);
export const Coverage = z
  .object({
    tier: z.enum(['general', 'supply', 'track']),
    tracks: z.array(TrackKey).default([]),
    goodsClass: z.enum(['food', 'nonfood']).optional(),
    frequency: z.enum(['opening', 'recurring']).optional(),
    workflows: z.array(WorkflowKey).default([]),
    jurisdictions: z.array(Jurisdiction).default([]),
  })
  .refine((v) => v.tier !== 'track' || v.tracks.length > 0, { path: ['tracks'] });
export type Coverage = z.infer<typeof Coverage>;
export const ParamKey = z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[A-Za-z0-9]+)+$/);
export function jurisdictionPrefixes(j: string): string[] {
  Jurisdiction.parse(j);
  const p = j.split('-');
  return p.map((_, i) => p.slice(0, i + 1).join('-'));
}
export function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}-`);
}
export function roundMoney(m: Money): Money {
  Money.parse(m);
  const n = ['JPY', 'KRW'].includes(m.currency) ? 0 : ['BHD', 'KWD'].includes(m.currency) ? 3 : 2;
  const factor = 10 ** n;
  return {
    amount: Math.round((m.amount + Math.sign(m.amount) * Number.EPSILON) * factor) / factor,
    currency: m.currency,
  };
}
export function sumMoney(ms: readonly Money[], currency?: string): Money {
  const c = currency ?? ms[0]?.currency;
  if (!c) throw new Error('Currency required for empty sum');
  if (ms.some((m) => m.currency !== c)) throw new Error('Currency mismatch');
  return roundMoney({ amount: ms.reduce((s, m) => s + m.amount, 0), currency: c });
}
export function divMoney(m: Money, n: number): Money | null {
  return n === 0 ? null : roundMoney({ amount: m.amount / n, currency: m.currency });
}
export function addDays(d: string, n: number): string {
  IsoDate.parse(d);
  if (!Number.isInteger(n)) throw new Error('Days must be integer');
  const date = new Date(`${d}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}
export function diffDays(a: string, b: string): number {
  IsoDate.parse(a);
  IsoDate.parse(b);
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}
export function todayIn(ianaTz: string, now: string): string {
  IsoDateTime.parse(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (k: string) => parts.find((p) => p.type === k)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
