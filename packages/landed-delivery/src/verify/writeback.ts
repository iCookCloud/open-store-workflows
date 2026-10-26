import {
  type AssetRecordOf,
  type Fill,
  type Product,
  type StepCtx,
  type Verification,
  assetRef,
} from '@osw/core';
import { verification } from '../helpers.js';
import type { PackingLine } from '../models.js';

export interface FillCandidate {
  productId: string;
  field: string;
  value: string | number;
}
export function candidatesFor(lines: PackingLine[]): FillCandidate[] {
  const candidates: FillCandidate[] = [];
  for (const line of lines) {
    if (!line.productRef) continue;
    const add = (field: string, value: unknown) => {
      if (
        (typeof value === 'number' && value > 0 && Number.isFinite(value)) ||
        (typeof value === 'string' && value.trim())
      )
        candidates.push({ productId: line.productRef!.id, field, value: value as string | number });
    };
    if (line.hsCode.src === 'manual' && line.hsCode.value) {
      const hs = line.hsCode.value.replace(/\s/g, '');
      if (/^\d{6,10}$/.test(hs)) add('hsCode', hs);
    }
    if (line.materialText.src === 'manual') add('customsMaterial', line.materialText.value);
    if (line.netWeightKg.src === 'manual') add('netWeightKg', line.netWeightKg.value);
    if (line.totalVolumeM3.src === 'manual' && line.totalVolumeM3.value)
      add('unitVolumeM3', line.totalVolumeM3.value / line.qty);
    if (
      line.cartonUnits.src === 'manual' &&
      ['forwarder', 'store'].includes(line.cartonUnits.by ?? '')
    )
      add('carton.units', line.cartonUnits.value);
    if (
      line.totalGrossWeightKg.src === 'manual' &&
      ['forwarder', 'store'].includes(line.totalGrossWeightKg.by ?? '') &&
      line.cartons.value &&
      line.totalGrossWeightKg.value
    )
      add('carton.grossWeightKg', line.totalGrossWeightKg.value / line.cartons.value);
  }
  return candidates;
}
export function writeback(
  candidates: FillCandidate[],
  products: AssetRecordOf<Product>[],
  ctx: StepCtx,
  step: string,
) {
  const groups = new Map<string, FillCandidate[]>();
  const fills: Fill[] = [];
  const verifications: Verification[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.productId}\0${candidate.field}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const candidate = group[0];
    const product = products.find((record) => record.id === candidate.productId);
    if (!product) continue;
    const ref = assetRef(product);
    if (new Set(group.map((candidate) => JSON.stringify(candidate.value))).size > 1) {
      verifications.push(
        verification(ctx, step, ref, candidate.field, 'pending', 'conflicting_values'),
      );
      continue;
    }
    const expected = candidate.field
      .split('.')
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined,
        product.data,
      );
    // 被权限隐藏的字段不是空值，不能用补空意图绕过读取权限。
    const hidden = product.redacted?.some((path) => {
      const field = path
        .replace(/^\//, '')
        .replaceAll('/', '.')
        .replace(/^data\./, '');
      return candidate.field === field || candidate.field.startsWith(`${field}.`);
    });
    if (hidden) {
      verifications.push(
        verification(ctx, step, ref, candidate.field, 'pending', 'Field is redacted'),
      );
      continue;
    }
    if (expected === undefined || expected === null || expected === '') {
      fills.push({
        asset: ref,
        field: candidate.field,
        value: candidate.value,
        at: ctx.now,
        by: ctx.actor,
      });
      verifications.push(
        verification(
          ctx,
          step,
          ref,
          candidate.field,
          'pending',
          'Verified observation supplied for an empty source field',
          { field: candidate.field, expected: null, actual: candidate.value },
        ),
      );
    } else
      verifications.push(
        verification(
          ctx,
          step,
          ref,
          candidate.field,
          expected === candidate.value ? 'holds' : 'fails',
          'Manual observation compared with source',
          {
            field: candidate.field,
            expected: typeof expected === 'number' ? expected : String(expected),
            actual: candidate.value,
            ...(typeof expected === 'number' && typeof candidate.value === 'number'
              ? { delta: candidate.value - expected }
              : {}),
          },
        ),
      );
  }
  return { fills, verifications };
}
