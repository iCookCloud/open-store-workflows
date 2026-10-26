import {
  type Need,
  OfferSlot,
  ProductSlot,
  type StepCtx,
  type StepDef,
  type Verification,
  assetRef,
  convertUnit,
  getMany,
  unitPriceAt,
  type z,
} from '@osw/core';
import { assertVersion, inputNeed, numberParam, result, withAssetParams } from '../helpers.js';
import { moneyIn } from '../price/model.js';
import { materialRateSlot } from '../slots/index.js';
import { SourceOutput } from './source-lines.js';
export async function verifyOffers(raw: z.infer<typeof SourceOutput>, baseCtx: StepCtx) {
  let ctx = baseCtx;
  const input = SourceOutput.parse(raw);
  const { draft, candidates } = input;
  const needs: Need[] = [];
  const verifications: Verification[] = [];
  const kinds = [...new Set(draft.lines.map((l) => l.lineKind))];
  const comparisonKeys = ['bom.offerBand.low', 'bom.offerBand.high', 'bom.specTolerance'];
  ctx = await withAssetParams(
    ctx,
    [
      ...comparisonKeys,
      ...kinds.flatMap((k) => comparisonKeys.map((key) => `${key}.${k}`)),
      'bom.rateCheckMinOffers',
    ],
    draft.context,
    draft,
  );
  const currentOffers = await getMany(
    ctx.assets,
    OfferSlot,
    Object.values(candidates).flatMap((rows) => rows.map((c) => c.offer.id)),
  );
  ctx = await withAssetParams(
    ctx,
    currentOffers
      .filter((o) => o.data.currency !== draft.currency)
      .map((o) => `fx.${o.data.currency}.${draft.currency}`),
    draft.context,
    draft,
  );
  const products = await getMany(
    ctx.assets,
    ProductSlot,
    draft.lines.flatMap((l) => (l.productRef ? [l.productRef.id] : [])),
  );
  const selectedRatios = new Map<string, { ratio: number; lineKind: string; offerId: string }[]>();
  const emit = (v: Omit<Verification, 'purpose' | 'at' | 'by'>) =>
    verifications.push({ ...v, purpose: 'fitout-bom/verifyOffers', at: ctx.now, by: ctx.actor });
  for (const line of draft.lines) {
    for (const candidate of candidates[line.id] ?? []) {
      const current = currentOffers.find((o) => o.id === candidate.offer.id);
      if (!assertVersion(current, assetRef(candidate.offer), needs)) continue;
      candidate.offer = current!;
      const quantity = convertUnit(line.qty, line.unit, current!.data.unit);
      const factor = convertUnit(1, line.unit, current!.data.unit);
      const rawPrice = quantity.value === null ? null : unitPriceAt(current!.data, quantity.value);
      const price =
        rawPrice && factor.value !== null
          ? moneyIn(
              { ...rawPrice, amount: rawPrice.amount * factor.value },
              draft.currency,
              ctx,
              needs,
            )
          : null;
      const model = line.modelCostPerUnit;
      let verdict: Verification['verdict'] = 'pending';
      let reason = 'Model cost or comparable supplier price is missing';
      if ((candidate.offer.data.includes ?? []).some((i) => i !== 'pack'))
        reason = 'Offer includes freight, installation or tax outside the model cost basis';
      else if (line.pricingMode === 'whole' && line.wholeEstimate?.basis === 'estimate')
        reason = 'Whole-item model is only an estimate';
      else if (model && price && model.amount > 0) {
        const low = numberParam(ctx, 'bom.offerBand.low', needs, line.lineKind, false);
        const high = numberParam(ctx, 'bom.offerBand.high', needs, line.lineKind, false);
        const ratio = price.amount / model.amount;
        if (low !== null && high !== null) {
          if (low < 0 || high < low) {
            needs.push(inputNeed('params.bom.offerBand', 'Invalid comparison band', false));
            reason = 'Comparison band is invalid';
          } else {
            verdict = ratio >= low && ratio <= high ? 'holds' : 'fails';
            reason = `Supplier/model ratio ${ratio}; accepted interval [${low}, ${high}]`;
          }
        } else reason = 'Comparison band is missing';
        if (line.offerRef?.id === candidate.offer.id) {
          const contributions = new Map<string, number>();
          for (const c of line.components)
            if (c.rateRef && !c.override)
              contributions.set(
                c.rateRef.id,
                (contributions.get(c.rateRef.id) ?? 0) +
                  (line.parts.find((p) => p.key === c.key)?.total.amount ?? 0),
              );
          for (const [rateId, amount] of contributions)
            if (amount / model.amount >= 0.5) {
              const entries = selectedRatios.get(rateId) ?? [];
              entries.push({ ratio, lineKind: line.lineKind, offerId: candidate.offer.id });
              selectedRatios.set(rateId, entries);
            }
        }
      } else if (model?.amount === 0) reason = 'Zero model cost cannot support a price ratio';
      emit({
        asset: assetRef(candidate.offer),
        verdict,
        dimension: 'unitPrice',
        reason,
        measured:
          model && price
            ? {
                field: 'tiers.unitPrice',
                expected: price.amount,
                actual: model.amount,
                unit: draft.currency,
                delta: model.amount - price.amount,
              }
            : undefined,
      });
    }
    const product = products.find((p) => p.id === line.productRef?.id);
    if (product && line.dimensionsMm) {
      const tolerance = numberParam(ctx, 'bom.specTolerance', needs, line.lineKind, false);
      const d = product.data.dimensionsMm;
      const differences = d
        ? (['l', 'w', 'h'] as const)
            .map((key) => ({ key, delta: Math.abs(d[key] - line.dimensionsMm![key]) }))
            .sort((a, b) => b.delta - a.delta)
        : [];
      const worst = differences[0];
      let verdict: Verification['verdict'] = 'pending';
      if (d && tolerance !== null && tolerance >= 0)
        verdict = worst.delta <= tolerance ? 'holds' : 'fails';
      emit({
        asset: assetRef(product),
        dimension: 'dimensionsMm',
        verdict,
        reason: d
          ? 'Product dimensions compared with reviewed line; tolerance in mm'
          : 'Product dimensions are missing',
        measured:
          d && worst
            ? {
                field: `dimensionsMm.${worst.key}`,
                expected: d[worst.key],
                actual: line.dimensionsMm[worst.key],
                unit: 'mm',
                delta: line.dimensionsMm[worst.key] - d[worst.key],
              }
            : undefined,
      });
    }
  }
  if (selectedRatios.size) {
    const min = numberParam(ctx, 'bom.rateCheckMinOffers', needs, undefined, false);
    const rates = await getMany(ctx.assets, materialRateSlot, [...selectedRatios.keys()]);
    if (min !== null && (!Number.isInteger(min) || min < 1))
      needs.push(inputNeed('params.bom.rateCheckMinOffers', 'Expected positive integer', false));
    else if (min !== null)
      for (const rate of rates) {
        const entries = [
          ...new Map(selectedRatios.get(rate.id)!.map((e) => [e.offerId, e])).values(),
        ];
        if (entries.length < min) continue;
        const ratios = entries.map((e) => e.ratio).sort((a, b) => a - b);
        const n = ratios.length;
        const median = n % 2 ? ratios[(n - 1) / 2] : (ratios[n / 2 - 1] + ratios[n / 2]) / 2;
        const low = numberParam(ctx, 'bom.offerBand.low', needs, entries[0].lineKind, false);
        const high = numberParam(ctx, 'bom.offerBand.high', needs, entries[0].lineKind, false);
        const base = moneyIn(
          {
            amount: rate.data.price.amount / rate.data.convert,
            currency: rate.data.price.currency,
          },
          draft.currency,
          ctx,
          needs,
        );
        if (low !== null && high !== null && low >= 0 && high >= low && base)
          emit({
            asset: assetRef(rate),
            dimension: 'price',
            verdict: median < low || median > high ? 'fails' : 'holds',
            reason: `Median supplier/model ratio from ${n} distinct selected offers is ${median}`,
            measured: {
              field: 'price',
              expected: base.amount,
              actual: base.amount * median,
              unit: draft.currency,
              delta: base.amount * (median - 1),
            },
          });
      }
  }
  return result(input, needs, verifications);
}
export const verifyOffersStep = {
  id: 'fitout-bom/verifyOffers',
  input: SourceOutput,
  output: SourceOutput,
  reads: ['offer', 'product', 'material-rate', 'params'],
  params: [
    { key: 'bom.offerBand.low', required: true, description: 'Lower supplier/model ratio' },
    { key: 'bom.offerBand.high', required: true, description: 'Upper supplier/model ratio' },
    {
      key: 'bom.specTolerance',
      unit: 'mm',
      required: true,
      description: 'Product dimension tolerance',
    },
    {
      key: 'bom.rateCheckMinOffers',
      required: true,
      description: 'Distinct offers required to verify material rate',
    },
  ],
  run: verifyOffers,
} satisfies StepDef<typeof SourceOutput, typeof SourceOutput>;
