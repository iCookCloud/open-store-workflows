import {
  type AssetReader,
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  type ParamScope,
  ParamsSlot,
  type SlotDef,
  type StepCtx,
  type StepDef,
  type StepResult,
  TemplateSlot,
  type Verification,
  assetRef,
  createParamReader,
  isWithin,
  stepResult,
  versionHash,
  type z,
} from '@osw/core';

export const inputNeed = (path: string, reason: string, blocking = true): Need => ({
  kind: 'input',
  path,
  reason,
  blocking,
});
export function parseNeeds(error: z.ZodError): Need[] {
  return error.issues.map((issue) =>
    inputNeed(issue.path.map(String).join('.') || 'input', issue.message),
  );
}
export function defineStep<I extends z.ZodType, O extends z.ZodType>(
  definition: StepDef<I, O>,
): StepDef<I, O> {
  return {
    ...definition,
    async run(raw, ctx) {
      const parsed = definition.input.safeParse(raw);
      if (!parsed.success)
        return { output: null, needs: parseNeeds(parsed.error), verifications: [] };
      return definition.run(parsed.data, ctx);
    },
  };
}
export const result = stepResult;
export function blocked<O = never>(
  needs: Need[],
  verifications: Verification[] = [],
): StepResult<O> {
  return { output: null, needs, verifications };
}
export async function queryAll<S extends z.ZodObject>(
  assets: AssetReader,
  slot: SlotDef<S>,
  filter: Filter | null,
) {
  const records: AssetRecordOf<z.infer<S>>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: Page<z.infer<S>> = await assets.query(slot, filter, { limit: 200, cursor });
    records.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Asset source returned a repeated cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}
export const uniqueRefs = (refs: readonly AssetRef[]) => [
  ...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values(),
];
export function jurisdictionFit(store: string, item?: string): 'yes' | 'no' | 'unsure' {
  if (!item || isWithin(store, item)) return 'yes';
  return isWithin(item, store) ? 'unsure' : 'no';
}
export async function selectTemplate<S extends z.ZodType>(
  ctx: StepCtx,
  kind: string,
  track: string,
  jurisdiction: string,
  content: S,
  ref?: AssetRef,
) {
  const needs: Need[] = [];
  const filter: Filter = {
    all: [
      { field: 'kind', op: 'eq', value: kind },
      {
        any: [
          { field: 'coverage.tracks', op: 'hasAny', value: [track] },
          { field: 'coverage.tier', op: 'eq', value: 'general' },
        ],
      },
    ],
  };
  let candidates = ref
    ? [await ctx.assets.get(TemplateSlot, ref.id)].filter((r) => r !== null)
    : await queryAll(ctx.assets, TemplateSlot, filter);
  candidates = candidates.filter(
    (r) =>
      r.data.kind === kind &&
      (r.coverage.tier === 'general' || r.coverage.tracks.includes(track)) &&
      jurisdictionFit(jurisdiction, r.data.jurisdiction) !== 'no' &&
      (!r.coverage.jurisdictions.length ||
        r.coverage.jurisdictions.some((j) => jurisdictionFit(jurisdiction, j) !== 'no')),
  );
  if (
    !ref &&
    candidates.some((r) => r.coverage.tier === 'track' && r.coverage.tracks.includes(track))
  )
    candidates = candidates.filter(
      (r) => r.coverage.tier === 'track' && r.coverage.tracks.includes(track),
    );
  if (candidates.length !== 1) {
    needs.push({
      kind: 'asset',
      slot: 'template',
      filter,
      reason: candidates.length ? 'Select one applicable template' : `Missing ${kind} template`,
      blocking: true,
    });
    return { needs, record: null, content: null };
  }
  const record = candidates[0];
  if (
    jurisdictionFit(jurisdiction, record.data.jurisdiction) === 'unsure' ||
    (record.coverage.jurisdictions.length &&
      !record.coverage.jurisdictions.some((j) => jurisdictionFit(jurisdiction, j) === 'yes'))
  )
    needs.push(
      inputNeed(
        'template.jurisdiction',
        'Confirm the more specific template jurisdiction manually',
        false,
      ),
    );
  if (ref && (ref.slot !== 'template' || record.versionHash !== ref.versionHash))
    needs.push(inputNeed('templateRef', 'Template reference is stale or belongs to another slot'));
  const parsed = content.safeParse(record.data.content);
  if (record.data.format !== 'json')
    needs.push(inputNeed('template.format', 'Opening templates must be JSON'));
  if (!parsed.success) needs.push(...parseNeeds(parsed.error));
  return { needs, record, content: parsed.success ? parsed.data : null };
}
export function verification(
  ctx: StepCtx,
  asset: AssetRef,
  purpose: string,
  dimension: string,
  verdict: Verification['verdict'],
  reason: string,
  evidence: string[] = [],
): Verification {
  return {
    asset,
    purpose,
    dimension,
    verdict,
    reason,
    evidence: evidence.slice(0, 20),
    at: ctx.now,
    by: ctx.actor,
  };
}
export function latestApproval(ctx: StepCtx, step: string, hash: string, subject?: string) {
  return ctx.approvals
    .filter(
      (a) =>
        a.step === step &&
        a.subjectHash === hash &&
        a.subject === subject &&
        Date.parse(a.at) <= Date.parse(ctx.now),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}
export async function validArtifact(
  value: { hash: string; body: unknown },
  path: string,
): Promise<Need[]> {
  return (await versionHash(value.body)) === value.hash
    ? []
    : [inputNeed(path, 'Artifact body does not match its hash')];
}
export { assetRef };

/** 定向补取动态参数，保留原 reader 的歧义与实际来源引用。 */
export async function withOpeningParams(ctx: StepCtx, keys: readonly string[], scope: ParamScope) {
  const records = [];
  const all = [...new Set(keys)];
  const batchSize = 200;
  for (let index = 0; index < all.length; index += batchSize)
    records.push(
      ...(await queryAll(ctx.assets, ParamsSlot, {
        field: 'key',
        op: 'in',
        value: all.slice(index, index + batchSize),
      })),
    );
  const extra = createParamReader(records, ctx.now, scope);
  const original = ctx.params;
  const useOriginal = (key: string, at?: ParamScope) => {
    const need = original.need?.(key, at);
    const extraNeed = extra.need?.(key, at);
    if (need?.kind === 'param' && need.reason === 'ambiguous') return true;
    if (extraNeed?.kind === 'param' && extraNeed.reason === 'ambiguous') return false;
    return extra.get(key, at) === undefined;
  };
  return {
    ...ctx,
    params: {
      get: (key: string, at?: ParamScope) =>
        useOriginal(key, at) ? original.get(key, at) : extra.get(key, at),
      need: (key: string, at?: ParamScope) =>
        useOriginal(key, at) ? original.need?.(key, at) : extra.need?.(key, at),
      refs: (key: string, at?: ParamScope) =>
        useOriginal(key, at) ? (original.refs?.(key, at) ?? []) : (extra.refs?.(key, at) ?? []),
    },
  } satisfies StepCtx;
}
