import {
  type AssetReader,
  type AssetRecordOf,
  type AssetRef,
  type Filter,
  type Need,
  type Page,
  type SlotDef,
  type StepCtx,
  type StepResult,
  type Verification,
  assetRef,
  isWithin,
  type z,
} from '@osw/core';
import { inputNeed, parseNeeds, verification } from '../helpers.js';
import type { TrainingScope } from './models.js';
export { inputNeed } from '../helpers.js';
export { queryAll as trainingQuery, uniqueRefs as uniqueTrainingRefs } from '../helpers.js';
export const trainingResult = <O>(
  output: O | null,
  needs: Need[] = [],
  verifications: Verification[] = [],
): StepResult<NonNullable<O>> => ({
  output: needs.some((n) => n.blocking) ? null : (output as NonNullable<O> | null),
  needs,
  verifications,
});
export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
): { value?: z.infer<S>; needs: Need[] } {
  const parsed = schema.safeParse(input);
  return parsed.success ? { value: parsed.data, needs: [] } : { needs: parseNeeds(parsed.error) };
}
export const trackFilter = (track: string): Filter => ({
  any: [
    { field: 'coverage.tracks', op: 'hasAny', value: [track] },
    { field: 'coverage.tier', op: 'eq', value: 'general' },
  ],
});
export function jurisdictionFit(
  jurisdiction: string,
  allowed: readonly string[],
): 'yes' | 'no' | 'unsure' {
  if (!allowed.length || allowed.some((j) => isWithin(jurisdiction, j))) return 'yes';
  return allowed.some((j) => isWithin(j, jurisdiction)) ? 'unsure' : 'no';
}
export function numericTrainingParam(
  ctx: StepCtx,
  key: string,
  scope: TrainingScope,
  needs: Need[],
  min = 0,
  max?: number,
): number | null {
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
    param.value < min ||
    (max !== undefined && param.value > max)
  ) {
    needs.push(inputNeed(`params.${key}`, 'Numeric parameter is outside its permitted range'));
    return null;
  }
  return param.value;
}
export async function readTrainingRef<S extends z.ZodObject>(
  ctx: StepCtx,
  slot: SlotDef<S>,
  ref: AssetRef,
  needs: Need[],
) {
  if (ref.slot !== slot.name) {
    needs.push(inputNeed('ref.slot', `Expected ${slot.name}`));
    return null;
  }
  const record = await ctx.assets.get(slot, ref.id);
  if (!record || assetRef(record, ref.fieldset).versionHash !== ref.versionHash) {
    needs.push({
      kind: 'asset',
      slot: slot.name,
      filter: { field: 'id', op: 'eq', value: ref.id },
      reason: record ? 'Referenced asset version has changed' : 'Referenced asset is unavailable',
      blocking: true,
    });
    return null;
  }
  return record;
}
export function trainingVerification(
  asset: AssetRef,
  purpose: string,
  verdict: Verification['verdict'],
  dimension: string,
  reason: string,
  ctx: StepCtx,
  extra: Partial<Verification> = {},
): Verification {
  return { ...verification(ctx, asset, purpose, dimension, verdict, reason), ...extra };
}
