import { type AssetRef, IsoDateTime, type Money, ParamKey, isWithin, roundMoney } from './base.js';
import type { AssetRecordOf } from './slot.js';
import { type Param, ParamsSlot } from './slots/index.js';
import type { AssetReader, Page } from './source.js';
import type { Need, ParamReader, ParamScope, StepCtx } from './step.js';
export interface ParamResolution {
  source?: AssetRef;
  value?: { value: number | string | boolean; unit?: string };
  need?: Need;
}
export function resolveParam(
  records: readonly AssetRecordOf<Param>[],
  key: string,
  now: string,
  scope: ParamScope = {},
): ParamResolution {
  ParamKey.parse(key);
  IsoDateTime.parse(now);
  const date = now.slice(0, 10);
  const candidates = records.filter(
    (r) =>
      (!r.data.validFrom || r.data.validFrom <= date) &&
      (!r.data.validTo || r.data.validTo >= date),
  );
  for (const k of scope.qualifier ? [`${key}.${scope.qualifier}`, key] : [key]) {
    const scored = candidates
      .filter((r) => r.data.key === k)
      .flatMap((r) => {
        const js = r.data.appliesTo?.jurisdictions ?? [];
        const ts = r.data.appliesTo?.tracks ?? [];
        const applicable = js.filter((j) => scope.jurisdiction && isWithin(scope.jurisdiction, j));
        if (
          (js.length && !applicable.length) ||
          (ts.length && (!scope.track || !ts.includes(scope.track)))
        )
          return [];
        return [
          {
            r,
            j: applicable.length ? Math.max(...applicable.map((j) => j.split('-').length)) : 0,
            t: ts.length ? 1 : 0,
          },
        ];
      })
      .sort(
        (a, b) =>
          b.j - a.j ||
          b.t - a.t ||
          ((a.r.data.validFrom ?? '') < (b.r.data.validFrom ?? '')
            ? 1
            : (a.r.data.validFrom ?? '') > (b.r.data.validFrom ?? '')
              ? -1
              : 0),
      );
    if (!scored.length) continue;
    const a = scored[0];
    const b = scored[1];
    if (b && a.j === b.j && a.t === b.t && a.r.data.validFrom === b.r.data.validFrom)
      return { need: { kind: 'param', key, reason: 'ambiguous', blocking: true } };
    return {
      source: { slot: a.r.slot, id: a.r.id, versionHash: a.r.versionHash },
      value: { value: a.r.data.value, ...(a.r.data.unit ? { unit: a.r.data.unit } : {}) },
    };
  }
  return { need: { kind: 'param', key, reason: 'missing', blocking: true } };
}
export function createParamReader(
  records: readonly AssetRecordOf<Param>[],
  now: string,
  defaultScope: ParamScope = {},
): ParamReader {
  return {
    refs: (key, scope) => {
      const source = resolveParam(records, key, now, { ...defaultScope, ...scope }).source;
      return source ? [source] : [];
    },
    get: (key, scope) => resolveParam(records, key, now, { ...defaultScope, ...scope }).value,
    need: (key, scope) => resolveParam(records, key, now, { ...defaultScope, ...scope }).need,
  };
}

export async function loadParameterRecords(
  assets: AssetReader,
  keys: readonly string[],
  includeQualified = false,
): Promise<AssetRecordOf<Param>[]> {
  const result = new Map<string, AssetRecordOf<Param>>();
  const unique = [...new Set(keys)];
  // keyPrefix 以点分段，labor.rate 不包含 labor.rateExtra；每次最多 32 个叶子。
  const batchSize = includeQualified ? 32 : 200;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: Page<Param> = await assets.query(
        ParamsSlot,
        includeQualified
          ? { any: batch.map((key) => ({ field: 'key', op: 'keyPrefix' as const, value: key })) }
          : { field: 'key', op: 'in', value: batch },
        { limit: 200, cursor },
      );
      for (const record of page.items) result.set(record.id, record);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seen.has(cursor)) throw new Error('Asset source returned a repeated parameter cursor');
        seen.add(cursor);
      }
    } while (cursor !== null);
  }
  return [...result.values()];
}

export async function withParameterKeys(
  ctx: StepCtx,
  keys: readonly string[],
  scope: ParamScope = {},
): Promise<StepCtx> {
  const ambiguous = (key: string, at: ParamScope) => {
    const need = ctx.params.need?.(key, at);
    return need?.kind === 'param' && need.reason === 'ambiguous';
  };
  const missing = [...new Set(keys)].filter(
    (key) => ctx.params.get(key, scope) === undefined && !ambiguous(key, scope),
  );
  if (!missing.length) return ctx;
  const extra = createParamReader(await loadParameterRecords(ctx.assets, missing), ctx.now, scope);
  const reader = (key: string, at: ParamScope) =>
    ctx.params.get(key, at) !== undefined || ambiguous(key, at) ? ctx.params : extra;
  return {
    ...ctx,
    params: {
      get: (key, at) => reader(key, { ...scope, ...at }).get(key, { ...scope, ...at }),
      need: (key, at) => reader(key, { ...scope, ...at }).need?.(key, { ...scope, ...at }),
      refs: (key, at) => reader(key, { ...scope, ...at }).refs?.(key, { ...scope, ...at }) ?? [],
    },
  };
}

export async function withFxParams(
  ctx: StepCtx,
  currencies: readonly string[],
  target: string,
  scope: ParamScope = {},
): Promise<StepCtx> {
  return withParameterKeys(
    ctx,
    currencies
      .filter((currency) => currency !== target)
      .map((currency) => `fx.${currency}.${target}`),
    scope,
  );
}
export function convertMoney(
  m: Money,
  currency: string,
  params: ParamReader,
  scope: ParamScope = {},
): { value: Money | null; needs: Need[] } {
  if (m.currency === currency) return { value: roundMoney(m), needs: [] };
  const key = `fx.${m.currency}.${currency}`;
  const rate = params.get(key, scope);
  if (!rate)
    return {
      value: null,
      needs: [
        params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
      ],
    };
  if (typeof rate.value !== 'number' || !Number.isFinite(rate.value) || rate.value <= 0)
    return {
      value: null,
      needs: [
        {
          kind: 'input',
          path: key,
          reason: 'Exchange rate must be positive finite number',
          blocking: true,
        },
      ],
    };
  return { value: roundMoney({ amount: m.amount * rate.value, currency }), needs: [] };
}
