import {
  type AssetReader,
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  type ParamDecl,
  type ParamReader,
  ParamsSlot,
  type SlotDef,
  type StepCtx,
  type StepResult,
  type Verification,
  getMany,
  type z,
} from '@osw/core';

export const PARAMS: readonly ParamDecl[] = [
  {
    key: 'concept.budgetBand',
    required: true,
    description: 'Fallback relative investment range, from 0 inclusive to 1 exclusive',
  },
  {
    key: 'concept.areaTolerance',
    required: true,
    description: 'Relative allowed area tolerance, from 0 inclusive to 1 exclusive',
  },
  {
    key: 'concept.calibrationMinSample',
    required: true,
    description: 'Minimum complete independent actual samples',
  },
  {
    key: 'verify.calcTemplateTolerance',
    required: true,
    description: 'Maximum relative deviation accepted for template verification',
  },
  {
    key: 'concept.minMarginRate',
    required: false,
    description: 'Minimum profit margin used to derive rent ceiling',
  },
];
export { assetRef } from '@osw/core';
export function result<O>(
  output: O,
  needs: Need[] = [],
  verifications: Verification[] = [],
): StepResult<O> {
  return { output: needs.some((need) => need.blocking) ? null : output, needs, verifications };
}
export const blocked = <O>(needs: Need[], verifications: Verification[] = []): StepResult<O> => ({
  output: null,
  needs,
  verifications,
});
export function inputNeeds(error: z.ZodError): Need[] {
  return error.issues.map((issue) => ({
    kind: 'input',
    path: issue.path.join('.'),
    reason: issue.message,
    blocking: true,
  }));
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
    if (cursor && seen.has(cursor))
      throw new Error('Asset source returned a repeated pagination cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}
export function scopeFor(brief: { jurisdiction: string }, track?: string) {
  return { jurisdiction: brief.jurisdiction, ...(track ? { track } : {}) };
}
export function numericParam(
  ctx: StepCtx,
  key: string,
  scope: { jurisdiction: string; track?: string },
  needs: Need[],
  options: {
    optional?: boolean;
    min?: number;
    max?: number;
    maxExclusive?: boolean;
    integer?: boolean;
  } = {},
): number | null {
  const found = ctx.params.get(key, scope);
  if (found === undefined) {
    const reader = ctx.params as ParamReader & {
      need?: (key: string, scope?: { jurisdiction?: string; track?: string }) => Need | undefined;
    };
    const need = reader.need?.(key, scope) ?? {
      kind: 'param' as const,
      key,
      reason: 'missing' as const,
      blocking: !options.optional,
    };
    needs.push({ ...need, blocking: !options.optional });
    return null;
  }
  if (
    typeof found.value !== 'number' ||
    !Number.isFinite(found.value) ||
    (options.min !== undefined && found.value < options.min) ||
    (options.max !== undefined &&
      (options.maxExclusive ? found.value >= options.max : found.value > options.max)) ||
    (options.integer && !Number.isInteger(found.value))
  ) {
    needs.push({
      kind: 'input',
      path: `params.${key}`,
      reason: 'Parameter value is outside its declared numeric range',
      blocking: !options.optional,
    });
    return null;
  }
  return found.value;
}
export { withFxParams } from '@osw/core';
export function uniqueRefs(refs: readonly z.infer<typeof AssetRef>[]) {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function parameterProvenance(
  ctx: StepCtx,
  keys: readonly string[],
  scope: { jurisdiction: string; track?: string },
): Promise<{ sources: AssetRef[]; example: boolean }> {
  const used = [...new Set(keys)].filter((key) => ctx.params.get(key, scope) !== undefined);
  const byKey = used.map((key) => [...(ctx.params.refs?.(key, scope) ?? [])]);
  const sources = uniqueRefs(byKey.flat());
  if (!used.length) return { sources, example: true };
  // refs 保留实际所用的旧版本；当前记录只用于确认合成标识，不能重算或替换哈希。
  const records = await getMany(
    ctx.assets,
    ParamsSlot,
    sources.map((source) => source.id),
  );
  const example =
    byKey.every((refs) => refs.length > 0) &&
    sources.every((source) =>
      records.some(
        (record) =>
          record.id === source.id &&
          record.versionHash === source.versionHash &&
          record.example === true,
      ),
    );
  return { sources, example };
}
