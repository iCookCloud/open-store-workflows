import { Jurisdiction, isWithin, jurisdictionPrefixes, z } from './base.js';
import { OswSourceError } from './errors.js';
import type { AnyAssetRecord, SlotDef } from './slot.js';
export const FilterOp = z.enum([
  'eq',
  'in',
  'gte',
  'lte',
  'contains',
  'hasAny',
  'hasAll',
  'exists',
  'within',
  'prefix',
]);
export type FilterOp = z.infer<typeof FilterOp>;
export type Scalar = string | number | boolean;
export type Filter =
  | { field: string; op: 'eq'; value: Scalar }
  | { field: string; op: 'in' | 'hasAny' | 'hasAll'; value: Scalar[] }
  | { field: string; op: 'gte' | 'lte'; value: number | string }
  | { field: string; op: 'contains' | 'prefix'; value: string }
  | { field: string; op: 'exists'; value: boolean }
  | { field: string; op: 'within'; value: { lat: number; lng: number; radiusKm: number } }
  | { all: Filter[] }
  | { any: Filter[] }
  | { not: Filter };
export const FilterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z
      .object({
        field: z.string().min(1),
        op: z.literal('eq'),
        value: z.union([z.string(), z.number().finite(), z.boolean()]),
      })
      .strict(),
    z
      .object({
        field: z.string().min(1),
        op: z.enum(['in', 'hasAny', 'hasAll']),
        value: z
          .array(z.union([z.string(), z.number().finite(), z.boolean()]))
          .min(1)
          .max(200),
      })
      .strict(),
    z
      .object({
        field: z.string().min(1),
        op: z.enum(['gte', 'lte']),
        value: z.union([z.number().finite(), z.string().regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/)]),
      })
      .strict(),
    z
      .object({ field: z.string().min(1), op: z.literal('contains'), value: z.string().min(3) })
      .strict(),
    z.object({ field: z.string().min(1), op: z.literal('prefix'), value: Jurisdiction }).strict(),
    z.object({ field: z.string().min(1), op: z.literal('exists'), value: z.boolean() }).strict(),
    z
      .object({
        field: z.string().min(1),
        op: z.literal('within'),
        value: z
          .object({
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
            radiusKm: z.number().positive().max(100),
          })
          .strict(),
      })
      .strict(),
    z.object({ all: z.array(FilterSchema).min(1) }).strict(),
    z.object({ any: z.array(FilterSchema).min(1) }).strict(),
    z.object({ not: FilterSchema }).strict(),
  ]),
);
const ENVELOPE = new Set([
  'id',
  'slot',
  'slotVersion',
  'versionHash',
  'updatedAt',
  'coverage',
  'example',
  'redacted',
  'fieldsetHashes',
]);
export function pathValues(object: unknown, path: string): unknown[] {
  const parts = path.split('.');
  let values: unknown[] = [object];
  for (const part of parts) {
    if (['__proto__', 'prototype', 'constructor'].includes(part.replace('[]', ''))) return [];
    const array = part.endsWith('[]');
    const key = array ? part.slice(0, -2) : part;
    values = values.flatMap((v) => {
      if (!v || typeof v !== 'object' || !Object.hasOwn(v, key)) return [];
      const n = (v as Record<string, unknown>)[key];
      return array ? (Array.isArray(n) ? n : []) : [n];
    });
  }
  return values;
}
export function recordValues(record: AnyAssetRecord, path: string): unknown[] {
  return pathValues(ENVELOPE.has(path.split('.')[0]) ? record : record.data, path);
}
export function filterFields(filter: Filter | null): string[] {
  if (!filter) return [];
  if ('all' in filter) return filter.all.flatMap(filterFields);
  if ('any' in filter) return filter.any.flatMap(filterFields);
  if ('not' in filter) return filterFields(filter.not);
  return [filter.field];
}
export function assertVisible(records: readonly AnyAssetRecord[], fields: readonly string[]): void {
  for (const r of records)
    for (const hidden of r.redacted ?? []) {
      const p = hidden
        .replace(/^\//, '')
        .replaceAll('/', '.')
        .replace(/^data\./, '')
        .replaceAll('[]', '');
      if (
        fields.some((field) => {
          const f = field.replaceAll('[]', '');
          return f === p || f.startsWith(`${p}.`) || p.startsWith(`${f}.`);
        })
      )
        throw new OswSourceError('field_forbidden', `Field is not visible: ${p}`, { status: 403 });
    }
}
export function validateFilter(slot: SlotDef, filter: Filter | null): void {
  if (filter === null) return;
  if (!FilterSchema.safeParse(filter).success)
    throw new OswSourceError('invalid_filter', 'Malformed filter', { status: 400 });
  let leaves = 0;
  const visit = (f: Filter, depth: number) => {
    if (depth > 4)
      throw new OswSourceError('invalid_filter', 'Filter nesting exceeds 4', { status: 400 });
    if ('all' in f) {
      for (const c of f.all) visit(c, depth + 1);
    } else if ('any' in f) {
      for (const c of f.any) visit(c, depth + 1);
    } else if ('not' in f) visit(f.not, depth + 1);
    else {
      leaves++;
      if (!slot.filterable[f.field]?.includes(f.op))
        throw new OswSourceError('filter_unsupported', `Unsupported ${f.field}/${f.op}`, {
          status: 400,
        });
    }
  };
  visit(filter, 1);
  if (leaves > 32)
    throw new OswSourceError('invalid_filter', 'Too many filter leaves', { status: 400 });
}
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const q =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(Math.max(0, 1 - q)));
}
function present(v: unknown): boolean {
  return v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0);
}
function leaf(v: unknown, f: Extract<Filter, { field: string }>): boolean {
  if (f.op === 'exists') return present(v) === f.value;
  if (!present(v)) return false;
  switch (f.op) {
    case 'eq':
      return v === f.value;
    case 'in':
      return f.value.includes(v as Scalar);
    case 'gte':
      return typeof v === typeof f.value && (v as number | string) >= f.value;
    case 'lte':
      return typeof v === typeof f.value && (v as number | string) <= f.value;
    case 'contains':
      return typeof v === 'string' && v.toLowerCase().includes(f.value.toLowerCase());
    case 'hasAny':
      return Array.isArray(v) && f.value.some((x) => v.includes(x));
    case 'hasAll':
      return Array.isArray(v) && f.value.every((x) => v.includes(x));
    case 'prefix':
      return typeof v === 'string' && isWithin(v, f.value);
    case 'within':
      return (
        typeof v === 'object' &&
        v !== null &&
        'lat' in v &&
        'lng' in v &&
        distanceKm(v as { lat: number; lng: number }, f.value) <= f.value.radiusKm
      );
  }
}
export function matchesFilter(record: AnyAssetRecord, filter: Filter | null): boolean {
  if (filter === null) return true;
  if ('all' in filter) return filter.all.every((f) => matchesFilter(record, f));
  if ('any' in filter) return filter.any.some((f) => matchesFilter(record, f));
  if ('not' in filter) return !matchesFilter(record, filter.not);
  const values = recordValues(record, filter.field);
  if (filter.op === 'exists') return values.some(present) === filter.value;
  return values.some((v) => leaf(v, filter));
}
export function jurisdictionCovers(field: string, j: string): Filter {
  return {
    any: [
      { field, op: 'hasAny', value: jurisdictionPrefixes(j) },
      { field, op: 'exists', value: false },
    ],
  };
}
export function withinFilter(filter: Filter | null): Extract<Filter, { op: 'within' }> | undefined {
  if (!filter) return undefined;
  if ('all' in filter) return filter.all.map(withinFilter).find(Boolean);
  if ('any' in filter) return filter.any.map(withinFilter).find(Boolean);
  if ('not' in filter) return withinFilter(filter.not);
  return filter.op === 'within' ? filter : undefined;
}
