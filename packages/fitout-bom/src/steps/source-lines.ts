import {
  AssetRecord,
  IsoDate,
  Money,
  type Need,
  Offer,
  OfferSlot,
  PartySlot,
  type StepCtx,
  type StepDef,
  addDays,
  assetRef,
  convertUnit,
  getMany,
  unitPriceAt,
  z,
} from '@osw/core';
import { addSources, approval, inputNeed, queryAll, result, withAssetParams } from '../helpers.js';
import { moneyIn } from '../price/model.js';
import { BomDraft } from '../schema.js';
export const OfferCandidate = z.object({
  offer: AssetRecord(Offer),
  unitPrice: Money.nullable(),
  offerQty: z.number().nonnegative(),
  arrivesInTime: z.boolean().nullable(),
});
export type OfferCandidate = z.infer<typeof OfferCandidate>;
export const SourceOutput = z.object({
  draft: BomDraft,
  candidates: z.record(z.string(), z.array(OfferCandidate)),
});
export const SourceInput = z.object({ draft: BomDraft, openingTarget: IsoDate });
export async function sourceLines(raw: z.infer<typeof SourceInput>, baseCtx: StepCtx) {
  let ctx = baseCtx;
  const { draft, openingTarget } = SourceInput.parse(raw);
  const needs: Need[] = [];
  const today = ctx.now.slice(0, 10);
  const ids = [...new Set(draft.lines.flatMap((l) => (l.productRef ? [l.productRef.id] : [])))];
  const offers: OfferCandidate['offer'][] = [];
  for (let start = 0; start < ids.length; start += 200)
    offers.push(
      ...(await queryAll(ctx, OfferSlot, {
        all: [
          { field: 'productId', op: 'in', value: ids.slice(start, start + 200) },
          { field: 'use', op: 'eq', value: 'project' },
          { field: 'validUntil', op: 'gte', value: today },
        ],
      })),
    );
  ctx = await withAssetParams(
    ctx,
    offers
      .filter((o) => o.data.currency !== draft.currency)
      .map((o) => `fx.${o.data.currency}.${draft.currency}`),
    draft.context,
    draft,
  );
  const parties = await getMany(
    ctx.assets,
    PartySlot,
    offers.map((o) => o.data.partyId),
  );
  const candidates: Record<string, OfferCandidate[]> = {};
  for (const line of draft.lines) {
    const rows: OfferCandidate[] = [];
    for (const offer of offers) {
      const o = offer.data;
      if (
        o.productId !== line.productRef?.id ||
        (o.validFrom && o.validFrom > today) ||
        o.quotedAt > today
      )
        continue;
      const party = parties.find((p) => p.id === o.partyId);
      if (!party || party.data.status !== 'active' || !party.data.roles.includes('supplier'))
        continue;
      const quantity = convertUnit(line.qty, line.unit, o.unit);
      if (quantity.value === null) {
        needs.push(
          inputNeed(`offers.${offer.id}.unit`, 'Offer unit cannot be compared to this line', false),
        );
        continue;
      }
      const price = unitPriceAt(o, quantity.value);
      if (!price) continue;
      const factor = convertUnit(1, line.unit, o.unit).value!;
      const converted = moneyIn(
        { ...price, amount: price.amount * factor },
        draft.currency,
        ctx,
        needs,
      );
      rows.push({
        offer,
        unitPrice: converted,
        offerQty: quantity.value,
        arrivesInTime: o.leadTimeDays ? addDays(today, o.leadTimeDays.max) <= openingTarget : null,
      });
    }
    rows.sort(
      (a, b) =>
        (a.unitPrice?.amount ?? Number.POSITIVE_INFINITY) -
          (b.unitPrice?.amount ?? Number.POSITIVE_INFINITY) ||
        Number(b.arrivesInTime === true) - Number(a.arrivesInTime === true) ||
        (a.offer.data.quotedAt > b.offer.data.quotedAt
          ? -1
          : a.offer.data.quotedAt < b.offer.data.quotedAt
            ? 1
            : a.offer.id < b.offer.id
              ? -1
              : 1),
    );
    candidates[line.id] = rows;
    // 每次重跑都清掉旧采购快照，只有本次候选内容的批示才能重新选中。
    line.offerRef = undefined;
    line.sourcing = null;
    line.costBasis = 'model';
    if (line.modelCostPerUnit)
      line.unitPrice = {
        ...line.modelCostPerUnit,
        basis: line.pricingMode === 'custom' ? 'model' : (line.wholeEstimate?.basis ?? 'estimate'),
      };
    if (!rows.length)
      needs.push({
        kind: 'action',
        action: 'rfq',
        ref: `line:${line.id}`,
        reason: 'No current eligible supplier offer',
        blocking: false,
      });
    const gate = await approval(
      ctx,
      'sourceLines',
      `line:${line.id}`,
      { line, candidates: rows, openingTarget },
      `为 ${line.name} 选择报价：${rows.map((r) => `${r.offer.id} (${r.unitPrice?.amount ?? '缺汇率'} ${draft.currency})`).join('、')}；none = 暂用模型成本`,
      [...rows.filter((r) => r.unitPrice !== null).map((r) => r.offer.id), 'none'],
    );
    if (!gate.accepted) {
      needs.push(gate.need);
      continue;
    }
    if (gate.accepted.decision === 'none') continue;
    const selected = rows.find((r) => r.offer.id === gate.accepted?.decision);
    if (!selected?.unitPrice) continue;
    const o = selected.offer.data;
    const tier = o.tiers.filter((t) => t.minQty <= selected.offerQty).at(-1)!;
    line.offerRef = assetRef(selected.offer);
    line.sourcing = {
      partyId: o.partyId,
      offerPrice: selected.unitPrice,
      tierMinQty: tier.minQty,
      incoterm: o.incoterm,
      includes: o.includes ?? [],
      quotedAt: o.quotedAt,
      validUntil: o.validUntil,
      leadTimeDays: o.leadTimeDays,
    };
    line.costBasis = 'offer';
    line.unitPrice = { ...selected.unitPrice, basis: o.basis };
  }
  addSources(draft, [...offers.map((o) => assetRef(o)), ...parties.map((p) => assetRef(p))]);
  return result({ draft, candidates }, needs);
}
export const sourceLinesStep = {
  id: 'fitout-bom/sourceLines',
  input: SourceInput,
  output: SourceOutput,
  reads: ['offer', 'party', 'params'],
  params: [],
  approval: { question: '确认供应商报价选择', decision: z.string() },
  run: sourceLines,
} satisfies StepDef<typeof SourceInput, typeof SourceOutput>;
