import {
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  type ParamDecl,
  type ParamScope,
  ParamsSlot,
  type SlotDef,
  type StepCtx,
  TemplateSlot,
  type Verification,
  assetRef,
  createParamReader,
  getMany,
  isWithin,
  type z,
} from '@osw/core';
import type { BuildOutInput } from './models.js';

export const PARAMS: readonly ParamDecl[] = [
  {
    key: 'labor.hourlyRate',
    required: true,
    description: 'Installation labor rate, unit CUR/h; trade qualifiers are resolved first',
  },
  {
    key: 'build.minBids',
    required: true,
    description: 'Minimum number of distinct contractor bids',
  },
  { key: 'build.crewSize', required: true, description: 'Positive integer crew size' },
  {
    key: 'build.hoursPerDay',
    required: true,
    unit: 'h',
    description: 'Positive daily working hours',
  },
  {
    key: 'build.workdays',
    required: true,
    description: 'Comma-separated ISO weekdays, 1 through 7',
  },
  {
    key: 'verify.installHours.tolerancePct',
    required: true,
    unit: '%',
    description: 'Allowed installation hours deviation',
  },
  {
    key: 'verify.siteMeasure.tolerancePct',
    required: true,
    unit: '%',
    description: 'Allowed site measurement deviation',
  },
];
export const inputNeed = (path: string, reason: string, blocking = true): Need => ({
  kind: 'input',
  path,
  reason,
  blocking,
});
export function uniqueRefs(refs: readonly AssetRef[]): AssetRef[] {
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
}
export const scopeFor = (input: BuildOutInput): ParamScope => ({
  jurisdiction: input.site.body.jurisdiction,
  track: input.track,
});
export async function queryAll<S extends z.ZodObject>(
  ctx: StepCtx,
  slot: SlotDef<S>,
  filter: Filter,
) {
  const records: AssetRecordOf<z.infer<S>>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Page<z.infer<S>> = await ctx.assets.query(slot, filter, { cursor, limit: 200 });
    records.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Repeated asset pagination cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}
export function applicable(record: AssetRecordOf<unknown>, input: BuildOutInput) {
  return (
    (!record.coverage.jurisdictions.length ||
      record.coverage.jurisdictions.some((j) => isWithin(input.site.body.jurisdiction, j))) &&
    (!record.coverage.tracks.length ||
      Boolean(input.track && record.coverage.tracks.includes(input.track)))
  );
}
export function approval(ctx: StepCtx, step: string, hash: string, role: string, subject?: string) {
  const matching = ctx.approvals
    .filter(
      (a) =>
        a.step === step &&
        a.subjectHash === hash &&
        a.role === role &&
        a.subject === subject &&
        Date.parse(a.at) <= Date.parse(ctx.now),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = matching[0];
  if (!latest) return undefined;
  // 同一时刻出现矛盾批示时要求重新确认，不能让数组顺序决定是否放行。
  if (
    matching.some(
      (a) => Date.parse(a.at) === Date.parse(latest.at) && a.decision !== latest.decision,
    )
  )
    return undefined;
  return latest;
}
export const approvalNeed = (
  step: string,
  subjectHash: string,
  question: string,
  subject?: string,
  blocking = true,
): Need => ({
  kind: 'approval',
  step,
  subjectHash,
  question,
  ...(subject ? { subject } : {}),
  blocking,
});
export function numericParam(
  ctx: StepCtx,
  key: string,
  input: BuildOutInput,
  needs: Need[],
  positive = false,
  integer = false,
): number | null {
  const scope = scopeFor(input);
  const param = ctx.params.get(key, scope);
  if (!param) {
    needs.push(
      ctx.params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
    );
    return null;
  }
  if (
    typeof param.value !== 'number' ||
    !Number.isFinite(param.value) ||
    (positive ? param.value <= 0 : param.value < 0) ||
    (integer && !Number.isInteger(param.value))
  ) {
    needs.push(inputNeed(`params.${key}`, 'Parameter must satisfy its numeric range'));
    return null;
  }
  return param.value;
}
// 动态汇率与工种键无法预先枚举；按明确键批量读取，保留宿主提供的值和歧义。
export async function withParams(
  ctx: StepCtx,
  keys: string[],
  input: BuildOutInput,
): Promise<StepCtx> {
  const missing = [...new Set(keys)].filter(
    (key) => ctx.params.get(key, scopeFor(input)) === undefined,
  );
  if (!missing.length) return ctx;
  const records = [];
  for (let i = 0; i < missing.length; i += 200)
    records.push(
      ...(await queryAll(ctx, ParamsSlot, {
        field: 'key',
        op: 'in',
        value: missing.slice(i, i + 200),
      })),
    );
  const extra = createParamReader(records, ctx.now, scopeFor(input));
  const ambiguous = (key: string, scope?: ParamScope) => {
    const need = ctx.params.need?.(key, scope);
    return need?.kind === 'param' && need.reason === 'ambiguous';
  };
  return {
    ...ctx,
    params: {
      get: (key, scope) =>
        ambiguous(key, scope) ? undefined : (ctx.params.get(key, scope) ?? extra.get(key, scope)),
      need: (key, scope) =>
        ambiguous(key, scope)
          ? ctx.params.need?.(key, scope)
          : (extra.need?.(key, scope) ?? ctx.params.need?.(key, scope)),
      refs: (key, scope) =>
        ctx.params.get(key, scope) === undefined
          ? (extra.refs?.(key, scope) ?? [])
          : (ctx.params.refs?.(key, scope) ?? []),
    },
  };
}
export function parameterRefs(ctx: StepCtx, keys: string[], input: BuildOutInput) {
  return uniqueRefs(keys.flatMap((key) => ctx.params.refs?.(key, scopeFor(input)) ?? []));
}
export async function parametersAreExamples(ctx: StepCtx, keys: string[], input: BuildOutInput) {
  const used = [...new Set(keys)].filter(
    (key) => ctx.params.get(key, scopeFor(input)) !== undefined,
  );
  const refs = used.map((key) => ctx.params.refs?.(key, scopeFor(input)) ?? []);
  if (refs.some((group) => !group.length)) return false;
  const sources = uniqueRefs(refs.flat());
  const records = await getMany(
    ctx.assets,
    ParamsSlot,
    sources.map((ref) => ref.id),
  );
  return sources.every((ref) =>
    records.some((r) => r.id === ref.id && r.versionHash === ref.versionHash && r.example === true),
  );
}
export function verification(
  ctx: StepCtx,
  asset: AssetRef,
  purpose: string,
  dimension: string,
  expected: number | string | null,
  actual: number | string,
  holds: boolean,
  unit?: string,
): Verification {
  return {
    asset,
    purpose,
    dimension,
    verdict: holds ? 'holds' : 'fails',
    reason: holds
      ? 'Observed value agrees with the referenced source'
      : 'Observed value differs from the referenced source',
    measured: {
      field: dimension,
      expected,
      actual,
      ...(unit ? { unit } : {}),
      ...(typeof expected === 'number' && typeof actual === 'number'
        ? { delta: actual - expected }
        : {}),
    },
    at: ctx.now,
    by: ctx.actor,
  };
}
export function withinPct(actual: number, expected: number, pct: number) {
  return Math.abs(actual - expected) <= (Math.abs(expected) * pct) / 100 + 1e-10;
}
export function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
export async function loadTemplate<S extends z.ZodType>(
  ctx: StepCtx,
  input: BuildOutInput,
  id: string,
  kind: string,
  schema: S,
  needs: Need[],
) {
  const record = await ctx.assets.get(TemplateSlot, id);
  if (!record) {
    needs.push({
      kind: 'asset',
      slot: 'template',
      filter: { field: 'id', op: 'eq', value: id },
      reason: `Missing ${kind} template`,
      blocking: true,
    });
    return null;
  }
  if (
    record.data.kind !== kind ||
    record.data.format !== 'json' ||
    !applicable(record, input) ||
    (record.data.jurisdiction && !isWithin(input.site.body.jurisdiction, record.data.jurisdiction))
  ) {
    needs.push(inputNeed(`templates.${id}`, `Expected applicable JSON ${kind} template`));
    return null;
  }
  return { record, content: schema.parse(record.data.content), ref: assetRef(record) };
}
