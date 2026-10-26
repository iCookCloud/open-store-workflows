import { type Need, type StepCtx, SupplyProgramBody, z } from '@osw/core';
import { numericParam, queryAll, result } from './helpers.js';
import { ReorderLine, lineKey, orderPlacedAt, reorderSlot } from './models-reorder.js';

export const ShareStore = z.object({
  storeId: z.string().min(1),
  segmentKey: z.string().min(1),
  seedLines: z.array(ReorderLine).nullable(),
});
const Input = z.object({ stores: z.array(ShareStore) });
export const ShareOutput = SupplyProgramBody.shape.replenishShare;

// 每家店独立算集合交集，再按分群累加分子、分母，避免不同店的同产品互相抵销。
export async function replenishShare(input: z.infer<typeof Input>, ctx: StepCtx) {
  const needs: Need[] = [];
  const windowDays = numericParam(ctx, 'program.shareWindowDays', needs, { min: 0 });
  const target = numericParam(ctx, 'program.shareTarget', needs, { min: 0, max: 1 });
  if (needs.some((need) => need.blocking)) return result<z.infer<typeof ShareOutput>>([], needs);
  const grouped = new Map<
    string,
    { segmentKey: string; stores: number; numerator: number; denominator: number; known: boolean }
  >();
  const cutoff = Date.parse(ctx.now) - (windowDays as number) * 86400000;
  for (const store of input.stores) {
    const expected = new Set(
      (store.seedLines ?? []).filter((line) => line.lineKind === 'food').map(lineKey),
    );
    const groupKey = `${store.segmentKey}|${expected.size ? 'bom' : 'none'}`;
    const group = grouped.get(groupKey) ?? {
      segmentKey: store.segmentKey,
      stores: 0,
      numerator: 0,
      denominator: 0,
      known: false,
    };
    group.stores++;
    if (store.seedLines !== null) {
      if (expected.size) {
        group.known = true;
        const orders = await queryAll(ctx.assets, reorderSlot, {
          field: 'storeId',
          op: 'eq',
          value: store.storeId,
        });
        const reordered = new Set(
          orders
            .filter(
              (record) =>
                record.data.state === 'delivered' &&
                Date.parse(orderPlacedAt(record.data)) >= cutoff &&
                Date.parse(orderPlacedAt(record.data)) <= Date.parse(ctx.now),
            )
            .flatMap((record) => record.data.lines.map(lineKey)),
        );
        group.denominator += expected.size;
        group.numerator += [...expected].filter((key) => reordered.has(key)).length;
      }
    }
    grouped.set(groupKey, group);
  }
  return result(
    [...grouped]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, group]) => ({
        segmentKey: group.segmentKey,
        basis: group.known ? ('bom' as const) : ('none' as const),
        stores: group.stores,
        byLines: group.denominator ? group.numerator / group.denominator : null,
        target: target as number,
      })),
    needs,
  );
}

export const computeReplenishShare = {
  id: 'replenishment/replenishShare',
  input: Input,
  output: ShareOutput,
  reads: ['reorder'],
  params: [
    {
      key: 'program.shareWindowDays',
      required: true,
      description: 'Observed replenishment lookback days',
    },
    {
      key: 'program.shareTarget',
      required: true,
      description: 'Target share of expected ingredient keys replenished',
    },
  ],
  run: replenishShare,
};
