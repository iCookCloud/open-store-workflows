import type { z } from './base.js';
import { OswSourceError } from './errors.js';
import type { Filter, Scalar } from './filter.js';
import {
  assertVisible,
  distanceKm,
  filterFields,
  matchesFilter,
  pathValues,
  recordValues,
  validateFilter,
  withinFilter,
} from './filter.js';
import { canonicalJson, fieldsetHash, versionHash } from './hash.js';
import type { AnyAssetRecord, AssetRecordOf, SlotDef } from './slot.js';
import { parseRecord } from './slot.js';
import { Fill, Verification, verificationKey } from './verification.js';
import type { RecordResult } from './verification.js';
export interface QueryOpts {
  limit?: number;
  cursor?: string | null;
  sort?: { field: string; dir: 'asc' | 'desc' }[];
}
export interface Page<T> {
  items: AssetRecordOf<T>[];
  nextCursor: string | null;
}
export interface CountOpts {
  groupBy: (string | { field: string; depth: 1 | 2 | 3 })[];
}
export interface AssetReader {
  query<S extends z.ZodObject>(
    slot: SlotDef<S>,
    filter: Filter | null,
    opts?: QueryOpts,
  ): Promise<Page<z.infer<S>>>;
  get<S extends z.ZodObject>(
    slot: SlotDef<S>,
    id: string,
  ): Promise<AssetRecordOf<z.infer<S>> | null>;
  count?(
    slot: SlotDef,
    filter: Filter | null,
    opts: CountOpts,
  ): Promise<{ key: Scalar[]; n: number }[]>;
}
export interface AssetSource extends AssetReader {
  recordVerification(vs: readonly Verification[]): Promise<RecordResult[]>;
  applyFills?(fs: readonly Fill[]): Promise<RecordResult[]>;
}
export function validateQuery(slot: SlotDef, filter: Filter | null, opts: QueryOpts = {}): void {
  validateFilter(slot, filter);
  if (
    opts.limit !== undefined &&
    (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)
  )
    throw new OswSourceError('invalid_limit', 'Limit must be 1–200', { status: 400 });
  if (
    opts.sort &&
    (opts.sort.length > 2 ||
      opts.sort.some(
        (s) =>
          !['asc', 'desc'].includes(s.dir) ||
          !(
            slot.sortable.includes(s.field) ||
            s.field === 'id' ||
            (s.field === '_distance' && withinFilter(filter))
          ),
      ))
  )
    throw new OswSourceError('sort_unsupported', 'Invalid sort', { status: 400 });
  if (
    opts.cursor &&
    (typeof opts.cursor !== 'string' ||
      new TextEncoder().encode(opts.cursor).length > 2048 ||
      !/^[A-Za-z0-9_-]+$/.test(opts.cursor))
  )
    throw new OswSourceError('invalid_cursor', 'Invalid cursor', { status: 400 });
}
function encode(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function decode(v: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(v.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    throw new OswSourceError('invalid_cursor', 'Malformed cursor', { status: 400 });
  }
}
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}
type QuerySort = { field: string; dir: 'asc' | 'desc' }[];
function queryOrder(filter: Filter | null, requested: QueryOpts['sort']) {
  const sort: QuerySort = [
    ...(requested ?? []).filter((s) => s.field !== 'id'),
    { field: 'id', dir: requested?.find((s) => s.field === 'id')?.dir ?? 'asc' },
  ];
  const center = withinFilter(filter);
  const keys = (record: AnyAssetRecord): unknown[] =>
    sort.map((s) => {
      if (s.field !== '_distance' || !center) return recordValues(record, s.field)[0] ?? null;
      const point = recordValues(record, center.field)[0] as
        | { lat: number; lng: number }
        | undefined;
      return point ? distanceKm(point, center.value) : null;
    });
  const compareKeys = (a: unknown[], b: unknown[]): number => {
    for (let i = 0; i < sort.length; i++) {
      const result = compare(a[i], b[i]);
      if (result) return sort[i].dir === 'desc' ? -result : result;
    }
    return 0;
  };
  return { sort, keys, compareKeys };
}
function cursorKeys(
  cursor: string | null | undefined,
  queryHash: string,
  width: number,
): unknown[] | undefined {
  if (!cursor) return undefined;
  const value = decode(cursor);
  if (!value || typeof value !== 'object')
    throw new OswSourceError('invalid_cursor', 'Malformed cursor', { status: 400 });
  const token = value as { q?: string; k?: unknown[] };
  if (
    token.q !== queryHash ||
    !Array.isArray(token.k) ||
    token.k.length !== width ||
    token.k.some((k) => k !== null && !['string', 'number', 'boolean'].includes(typeof k))
  )
    throw new OswSourceError('invalid_cursor', 'Cursor does not match query', { status: 400 });
  return token.k;
}
function prepareFill(
  record: AnyAssetRecord,
  fill: Fill,
  slot: SlotDef | undefined,
): { record: AnyAssetRecord } | { error: RecordResult } {
  const parts = fill.field.replace(/^\//, '').replaceAll('/', '.').split('.');
  if (parts.some((p) => ['__proto__', 'constructor', 'prototype', ''].includes(p)))
    return { error: { status: 'rejected', detail: 'Invalid field path' } };
  assertVisible([record], [parts.join('.')]);
  if (fill.asset.fieldset && !slot?.fieldsets?.[fill.asset.fieldset]?.includes(parts[0]))
    return {
      error: { status: 'rejected', detail: 'Referenced fieldset does not cover the fill target' },
    };
  if (record.redacted?.length)
    return {
      error: { status: 'rejected', detail: 'Cannot recompute a partially redacted record' },
    };
  if (fill.value === null || fill.value === undefined || fill.value === '')
    return { error: { status: 'rejected', detail: 'Fill must supply a nonempty value' } };
  const next = structuredClone(record);
  let parent = next.data as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) {
    if (parent[key] === null || parent[key] === undefined) parent[key] = {};
    if (typeof parent[key] !== 'object' || Array.isArray(parent[key]))
      return { error: { status: 'rejected', detail: 'Invalid parent field' } };
    parent = parent[key] as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  if (parent[key] !== undefined && parent[key] !== null && parent[key] !== '')
    return { error: { status: 'not_empty' } };
  parent[key] = structuredClone(fill.value);
  try {
    if (slot) {
      const validated = slot.schema.parse(next.data);
      slot.validate?.(validated);
      const stored = pathValues(validated, parts.join('.'));
      if (stored.length !== 1 || canonicalJson(stored[0]) !== canonicalJson(fill.value))
        return {
          error: { status: 'rejected', detail: 'Fill field is not declared or value was stripped' },
        };
    }
  } catch {
    return { error: { status: 'rejected', detail: 'Fill violates slot schema' } };
  }
  return { record: next };
}
async function rehashRecord(record: AnyAssetRecord, slot: SlotDef | undefined): Promise<void> {
  record.versionHash = await versionHash(record.data);
  if (!slot?.fieldsets) return;
  record.fieldsetHashes ??= {};
  for (const [name, keys] of Object.entries(slot.fieldsets))
    record.fieldsetHashes[name] = await fieldsetHash(record.data, keys);
}
export class MemorySource implements AssetSource {
  private mutation: Promise<unknown> = Promise.resolve();
  protected records: AnyAssetRecord[];
  protected slots = new Map<string, SlotDef>();
  readonly verifications: Verification[] = [];
  readonly fills: Fill[] = [];
  constructor(records: readonly AnyAssetRecord[] = [], slots: readonly SlotDef[] = []) {
    this.records = structuredClone([...records]);
    for (const s of slots) this.slots.set(s.name, s);
  }
  add(record: AnyAssetRecord): void {
    const i = this.records.findIndex((r) => r.slot === record.slot && r.id === record.id);
    if (i < 0) this.records.push(structuredClone(record));
    else this.records[i] = structuredClone(record);
  }
  snapshot(): AnyAssetRecord[] {
    return structuredClone(this.records);
  }
  protected async ready(): Promise<void> {}
  async query<S extends z.ZodObject>(
    slot: SlotDef<S>,
    filter: Filter | null,
    opts: QueryOpts = {},
  ): Promise<Page<z.infer<S>>> {
    await this.ready();
    this.slots.set(slot.name, slot);
    validateQuery(slot, filter, opts);
    const candidates = this.records.filter((r) => r.slot === slot.name);
    assertVisible(candidates, [...filterFields(filter), ...(opts.sort ?? []).map((s) => s.field)]);
    const { sort, keys, compareKeys } = queryOrder(filter, opts.sort);
    const q = await versionHash({ slot: slot.name, filter, sort });
    const last = cursorKeys(opts.cursor, q, sort.length);
    const sorted = candidates
      .filter((r) => matchesFilter(r, filter))
      .sort((a, b) => compareKeys(keys(a), keys(b)))
      .filter((r) => !last || compareKeys(keys(r), last) > 0);
    const page = sorted.slice(0, opts.limit ?? 50);
    return {
      items: page.map((r) => structuredClone(parseRecord(slot, r))),
      nextCursor:
        sorted.length > page.length ? encode({ q, k: keys(page[page.length - 1]) }) : null,
    };
  }
  async get<S extends z.ZodObject>(
    slot: SlotDef<S>,
    id: string,
  ): Promise<AssetRecordOf<z.infer<S>> | null> {
    await this.ready();
    this.slots.set(slot.name, slot);
    const r = this.records.find((r) => r.slot === slot.name && r.id === id);
    return r ? structuredClone(parseRecord(slot, r)) : null;
  }
  async count(
    slot: SlotDef,
    filter: Filter | null,
    opts: CountOpts,
  ): Promise<{ key: Scalar[]; n: number }[]> {
    await this.ready();
    validateFilter(slot, filter);
    if (opts.groupBy.length < 1 || opts.groupBy.length > 2)
      throw new OswSourceError('invalid_filter', 'Group by must have 1–2 keys', { status: 400 });
    const fields = opts.groupBy.map((g) => (typeof g === 'string' ? g : g.field));
    for (const f of fields)
      if (!slot.filterable[f])
        throw new OswSourceError('filter_unsupported', `Unsupported grouping ${f}`, {
          status: 400,
        });
    const records = this.records.filter((r) => r.slot === slot.name);
    assertVisible(records, [...filterFields(filter), ...fields]);
    const groups = new Map<string, { key: Scalar[]; n: number }>();
    for (const r of records.filter((r) => matchesFilter(r, filter))) {
      let keys: Scalar[][] = [[]];
      for (const g of opts.groupBy) {
        let value = recordValues(r, typeof g === 'string' ? g : g.field)[0];
        if (typeof g !== 'string') {
          if (![1, 2, 3].includes(g.depth)) throw new OswSourceError('invalid_filter');
          value = typeof value === 'string' ? value.split('-').slice(0, g.depth).join('-') : value;
        }
        const values = (Array.isArray(value) ? value : [value]).filter((v) =>
          ['string', 'number', 'boolean'].includes(typeof v),
        ) as Scalar[];
        keys = keys.flatMap((k) => [...new Set(values)].map((v) => [...k, v]));
      }
      for (const key of keys) {
        const k = canonicalJson(key);
        const group = groups.get(k) ?? { key, n: 0 };
        group.n++;
        groups.set(k, group);
        if (groups.size > 1000)
          throw new OswSourceError('too_many', 'Too many groups', { status: 413 });
      }
    }
    return [...groups.values()].sort((a, b) => compare(canonicalJson(a.key), canonicalJson(b.key)));
  }
  protected referenceStatus(ref: Fill['asset']): RecordResult | null {
    const r = this.records.find((r) => r.slot === ref.slot && r.id === ref.id);
    if (!r) return { status: 'not_found' };
    const hash = ref.fieldset ? r.fieldsetHashes?.[ref.fieldset] : r.versionHash;
    return hash === ref.versionHash ? null : { status: 'source_changed' };
  }
  async recordVerification(vs: readonly Verification[]): Promise<RecordResult[]> {
    await this.ready();
    if (vs.length > 200)
      throw new OswSourceError('too_many', 'At most 200 verifications', { status: 413 });
    const parsed = vs.map((raw) => Verification.parse(raw));
    const seen = new Set(this.verifications.map(verificationKey));
    return parsed.map((v) => {
      const status = this.referenceStatus(v.asset);
      if (status) return status;
      const key = verificationKey(v);
      if (seen.has(key)) return { status: 'duplicate' };
      seen.add(key);
      this.verifications.push(structuredClone(v));
      return { status: 'recorded' };
    });
  }
  async applyFills(fs: readonly Fill[]): Promise<RecordResult[]> {
    await this.ready();
    const work = this.mutation.then(() => this.commitFills(fs));
    this.mutation = work.catch(() => {});
    return work;
  }
  private async commitFills(fs: readonly Fill[]): Promise<RecordResult[]> {
    if (fs.length > 200) throw new OswSourceError('too_many', 'At most 200 fills', { status: 413 });
    const parsed = fs.map((raw) => Fill.parse(raw));
    // 同一批意图共享读取时版本；批内每次仍检查当前目标格为空，跨批调用仍严格校验新版本。
    const initialStatuses = parsed.map((fill) => this.referenceStatus(fill.asset));
    const results: RecordResult[] = [];
    for (const [index, f] of parsed.entries()) {
      const status = initialStatuses[index];
      if (status) {
        results.push(status);
        continue;
      }
      const r = this.records.find((r) => r.slot === f.asset.slot && r.id === f.asset.id)!;
      const slot = this.slots.get(r.slot);
      if (!slot) {
        results.push({
          status: 'unsupported',
          detail: 'Slot schema is required to validate fills',
        });
        continue;
      }
      const prepared = prepareFill(r, f, slot);
      if ('error' in prepared) {
        results.push(prepared.error);
        continue;
      }
      const next = prepared.record;
      await rehashRecord(next, slot);
      if (next.versionHash === r.versionHash) {
        results.push({ status: 'rejected', detail: 'Fill did not change the asset' });
        continue;
      }
      this.add(next);
      this.fills.push(structuredClone(f));
      results.push({ status: 'recorded' });
    }
    return results;
  }
}
export async function getMany<S extends z.ZodObject>(
  reader: AssetReader,
  slot: SlotDef<S>,
  ids: readonly string[],
): Promise<AssetRecordOf<z.infer<S>>[]> {
  const out: AssetRecordOf<z.infer<S>>[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 200) {
    let cursor: string | null = null;
    do {
      const p: Page<z.infer<S>> = await reader.query(
        slot,
        { field: 'id', op: 'in', value: unique.slice(i, i + 200) },
        { limit: 200, cursor },
      );
      out.push(...p.items);
      cursor = p.nextCursor;
    } while (cursor);
  }
  return out;
}
