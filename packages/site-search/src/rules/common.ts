import { createParamReader, paramsSlot } from '@osw/core';
import type { AssetRecordOf, Filter, Need, Page, SlotDef, StepCtx, StepResult, z } from '@osw/core';
export type Verdict = 'holds' | 'fails' | 'pending';
export interface Check {
  key: string;
  verdict: Verdict;
  reason: string;
  hard: boolean;
}
export function inputNeed(path: string, reason: string, blocking = true): Need {
  return { kind: 'input', path, reason, blocking };
}
export { assetRef, distanceKm } from '@osw/core';
export function result<O>(output: O, needs: Need[] = []): StepResult<NonNullable<O>> {
  return {
    output: needs.some((n) => n.blocking) ? null : (output as NonNullable<O>),
    needs,
    verifications: [],
  };
}
export function numberParam(
  ctx: StepCtx,
  key: string,
  needs: Need[],
  at?: { jurisdiction?: string; track?: string; qualifier?: string },
  blocking = true,
): number | undefined {
  const issue = ctx.params.need?.(key, at);
  if (issue) {
    needs.push({ ...issue, blocking });
    return undefined;
  }
  const param = ctx.params.get(key, at);
  if (!param) {
    needs.push({ kind: 'param', key, reason: 'missing', blocking });
    return undefined;
  }
  if (typeof param.value !== 'number' || !Number.isFinite(param.value) || param.value < 0) {
    needs.push(inputNeed(`params.${key}`, 'A finite nonnegative number is required', blocking));
    return undefined;
  }
  return param.value;
}
export async function queryAll<S extends z.ZodObject>(
  ctx: StepCtx,
  slot: SlotDef<S>,
  filter: Filter | null,
  cap: number,
): Promise<AssetRecordOf<z.infer<S>>[]> {
  const rows: AssetRecordOf<z.infer<S>>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: Page<z.infer<S>> = await ctx.assets.query(slot, filter, {
      limit: Math.min(200, cap - rows.length),
      cursor,
    });
    rows.push(...page.items.slice(0, cap - rows.length));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Asset source repeated a cursor');
    if (cursor) seen.add(cursor);
  } while (cursor && rows.length < cap);
  return rows;
}
// FX 键由取回的资产币种决定，不能在静态 ParamDecl 中枚举所有货币对。
export async function withExchangeRates(
  ctx: StepCtx,
  pairs: readonly [string, string][],
): Promise<StepCtx> {
  const keys = [...new Set(pairs.filter(([a, b]) => a !== b).map(([a, b]) => `fx.${a}.${b}`))];
  if (!keys.length) return ctx;
  const records = [];
  for (let offset = 0; offset < keys.length; offset += 200)
    records.push(
      ...(await queryAll(
        ctx,
        paramsSlot,
        { field: 'key', op: 'in', value: keys.slice(offset, offset + 200) },
        Number.MAX_SAFE_INTEGER,
      )),
    );
  const reader = createParamReader(records, ctx.now);
  const present = new Set(records.map((r) => r.data.key));
  return {
    ...ctx,
    params: {
      get: (key, scope) => (present.has(key) ? reader.get(key, scope) : ctx.params.get(key, scope)),
      need: (key, scope) =>
        present.has(key) ? reader.need?.(key, scope) : ctx.params.need?.(key, scope),
    },
  };
}
