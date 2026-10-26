import type { AssetRef, Need, ParamScope, StepCtx } from '@osw/core';
import { inputNeed, uniqueRefs } from '../helpers.js';
export {
  inputNeed,
  queryAll as queryPages,
  withOpeningParams as withMarketingParams,
} from '../helpers.js';

export function numeric(
  ctx: StepCtx,
  key: string,
  scope: ParamScope,
  needs: Need[],
  max?: number,
): number | null {
  const value = ctx.params.get(key, scope);
  if (!value) {
    needs.push(
      ctx.params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
    );
    return null;
  }
  if (
    typeof value.value !== 'number' ||
    !Number.isFinite(value.value) ||
    value.value < 0 ||
    (max !== undefined && value.value > max)
  ) {
    needs.push(
      inputNeed(
        `params.${key}`,
        'Expected a finite nonnegative parameter within its declared range',
      ),
    );
    return null;
  }
  return value.value;
}
export function usedParamRefs(
  ctx: StepCtx,
  uses: readonly { key: string; scope: ParamScope }[],
): AssetRef[] {
  return uniqueRefs(uses.flatMap(({ key, scope }) => ctx.params.refs?.(key, scope) ?? []));
}
