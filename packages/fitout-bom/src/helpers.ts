import {
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  type ParamScope,
  ParamsSlot,
  type SlotDef,
  type StepCtx,
  type StepResult,
  type Verification,
  assetRef,
  createParamReader,
  versionHash,
  type z,
} from '@osw/core';
import type { BomDraft } from './schema.js';
export function result(
  output: null,
  needs: Need[],
  verifications?: Verification[],
): StepResult<never>;
export function result<T>(output: T, needs?: Need[], verifications?: Verification[]): StepResult<T>;
export function result<T>(
  output: T | null,
  needs: Need[] = [],
  verifications: Verification[] = [],
): StepResult<T> {
  return { output: needs.some((n) => n.blocking) ? null : output, needs, verifications };
}
export function inputNeed(path: string, reason: string, blocking = true): Need {
  return { kind: 'input', path, reason, blocking };
}
export function addSources(draft: BomDraft, refs: AssetRef[]): void {
  const key = (r: AssetRef) =>
    `${r.slot}/${r.id}/${r.versionHash}/${r.fieldset ?? ''}/${r.path ?? ''}`;
  draft.sources = [...new Map([...draft.sources, ...refs].map((r) => [key(r), r])).values()];
}
export async function approval(
  ctx: StepCtx,
  step: string,
  subject: string,
  body: unknown,
  question: string,
  decisions?: readonly string[],
) {
  const subjectHash = await versionHash(body);
  const latest = ctx.approvals
    .filter(
      (a) =>
        a.step === `fitout-bom/${step}` &&
        a.subject === subject &&
        a.subjectHash === subjectHash &&
        a.at <= ctx.now,
    )
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value.at.localeCompare(a.value.at) || b.index - a.index)[0]?.value;
  const accepted =
    latest && (!decisions || decisions.includes(latest.decision)) ? latest : undefined;
  return {
    accepted,
    need: {
      kind: 'approval',
      step: `fitout-bom/${step}`,
      subject,
      subjectHash,
      question,
      blocking: true,
    } satisfies Need,
  };
}
export async function queryAll<S extends z.ZodObject>(
  ctx: StepCtx,
  slot: SlotDef<S>,
  filter: Filter | null,
) {
  const records: AssetRecordOf<z.infer<S>>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: Page<z.infer<S>> = await ctx.assets.query(slot, filter, { limit: 200, cursor });
    records.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Asset source repeated cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}
export function assertVersion(
  record: { versionHash: string; fieldsetHashes?: Record<string, string> } | undefined,
  ref: AssetRef,
  needs: Need[],
): boolean {
  if (
    !record ||
    (ref.fieldset ? record.fieldsetHashes?.[ref.fieldset] : record.versionHash) !== ref.versionHash
  ) {
    needs.push(
      inputNeed(
        `sources.${ref.slot}.${ref.id}`,
        record
          ? 'Asset version changed; refresh the input and approvals'
          : 'Referenced asset is missing',
      ),
    );
    return false;
  }
  return true;
}
export function numberParam(
  ctx: StepCtx,
  key: string,
  needs: Need[],
  qualifier?: string,
  blocking = true,
): number | null {
  const p = ctx.params.get(key, qualifier ? { qualifier } : undefined);
  if (!p) {
    needs.push({
      ...(ctx.params.need?.(key, qualifier ? { qualifier } : undefined) ?? {
        kind: 'param' as const,
        key,
        reason: 'missing' as const,
      }),
      blocking,
    });
    return null;
  }
  if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
    needs.push(inputNeed(`params.${key}`, 'Expected a finite number', blocking));
    return null;
  }
  return p.value;
}
export { assetRef };

// 外币和按品类细分的键只有读到资产后才确定，仍按 key 批量读取，禁止全库预取。
export async function withAssetParams(
  ctx: StepCtx,
  keys: string[],
  scope: ParamScope = {},
  draft?: BomDraft,
): Promise<StepCtx> {
  const unique = [...new Set(keys)];
  const records = [];
  for (let i = 0; i < unique.length; i += 200)
    records.push(
      ...(await queryAll(ctx, ParamsSlot, {
        field: 'key',
        op: 'in',
        value: unique.slice(i, i + 200),
      })),
    );
  if (draft)
    addSources(
      draft,
      records.map((r) => assetRef(r)),
    );
  const reader = createParamReader(records, ctx.now, scope);
  const ambiguous = (key: string, at?: ParamScope) => {
    const need = reader.need?.(key, at);
    return need?.kind === 'param' && need.reason === 'ambiguous' ? need : undefined;
  };
  return {
    ...ctx,
    params: {
      get: (key, at) =>
        ambiguous(key, at)
          ? undefined
          : (reader.get(key, at) ?? ctx.params.get(key, { ...scope, ...at })),
      need: (key, at) =>
        ambiguous(key, at) ?? ctx.params.need?.(key, { ...scope, ...at }) ?? reader.need?.(key, at),
    },
  };
}
