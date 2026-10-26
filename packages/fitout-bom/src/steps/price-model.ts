import { type StepCtx, type StepDef, assetRef, getMany, z } from '@osw/core';
import { addSources, result, withAssetParams } from '../helpers.js';
import { priceLine } from '../price/model.js';
import { BomDraft } from '../schema.js';
import { materialRateSlot } from '../slots/index.js';
export const PriceInput = z.object({ draft: BomDraft });
export async function priceModel(raw: z.infer<typeof PriceInput>, baseCtx: StepCtx) {
  let ctx = baseCtx;
  const { draft } = PriceInput.parse(raw);
  const rates = await getMany(
    ctx.assets,
    materialRateSlot,
    draft.lines.flatMap((l) => l.components.flatMap((c) => (c.rateRef ? [c.rateRef.id] : []))),
  );
  const currencies = [
    ...rates.map((r) => r.data.price.currency),
    ...draft.lines.flatMap((l) => [
      l.wholeEstimate?.unit.currency,
      ...l.components.flatMap((c) => [c.rate?.currency, c.override?.rate.currency]),
    ]),
  ].filter((c): c is string => !!c && c !== draft.currency);
  ctx = await withAssetParams(
    ctx,
    currencies.map((c) => `fx.${c}.${draft.currency}`),
    draft.context,
    draft,
  );
  const rateMap = new Map(rates.map((r) => [r.id, r]));
  const priced = draft.lines.map((l) => priceLine(l, draft.currency, rateMap, ctx));
  draft.lines = priced.map((r) => r.line);
  addSources(draft, [
    ...rates.map((r) => assetRef(r)),
    ...draft.lines.flatMap((line) => (line.wholeEstimate?.ref ? [line.wholeEstimate.ref] : [])),
  ]);
  return result(
    draft,
    priced.flatMap((r) => r.needs),
  );
}
export const priceModelStep = {
  id: 'fitout-bom/priceModel',
  input: PriceInput,
  output: BomDraft,
  reads: ['material-rate', 'params'],
  params: [],
  run: priceModel,
} satisfies StepDef<typeof PriceInput, typeof BomDraft>;
