import {
  ArtifactEnvelope,
  type Need,
  ProductSlot,
  type Requirement,
  SiteDecisionBody,
  type StepCtx,
  type StepDef,
  StoreSpecBody,
  assetRef,
  convertUnit,
  getMany,
  meets,
  z,
} from '@osw/core';
import {
  addSources,
  approval,
  inputNeed,
  numberParam,
  result,
  withAssetParams,
} from '../helpers.js';
import { type SiteMetrics, resolveQuantities } from '../price/qty.js';
import { BomDraft } from '../schema.js';
export const StoreSpec = ArtifactEnvelope('StoreSpec', StoreSpecBody);
export const SiteDecision = ArtifactEnvelope('SiteDecision', SiteDecisionBody);
export const ScaleInput = z.object({ draft: BomDraft, store: StoreSpec, site: SiteDecision });
export async function scaleToSite(raw: z.infer<typeof ScaleInput>, baseCtx: StepCtx) {
  const { draft, store, site } = ScaleInput.parse(raw);
  const needs: Need[] = [];
  draft.context = { jurisdiction: store.body.jurisdiction, track: store.body.concept.track };
  const ctx = await withAssetParams(baseCtx, ['site.powerDiversity'], draft.context, draft);
  const metrics: SiteMetrics = { seats: store.body.capacity.seats };
  for (const [key, unit] of [
    ['area', 'm2'],
    ['frontage', 'm'],
    ['clearHeight', 'mm'],
  ] as const) {
    const reading = site.body.conditions.find((c) => c.key === key)?.measure;
    if (reading && typeof reading.value === 'number' && reading.unit) {
      const converted = convertUnit(reading.value, reading.unit, unit);
      if (converted.value !== null) metrics[key] = converted.value;
      else if (draft.lines.some((l) => l.qtyRule.kind === 'site' && l.qtyRule.metric === key))
        needs.push(...converted.needs);
    }
  }
  try {
    const quantities = resolveQuantities(draft.lines, metrics);
    draft.lines = draft.lines.map((l) => ({
      ...l,
      qty: quantities.get(l.id)!,
      qtyBasis:
        l.qtyRule.kind === 'manual' || l.qtyRule.kind === 'menu'
          ? l.qtyBasis
          : { status: 'derived', note: `Quantity rule: ${l.qtyRule.kind}` },
    }));
  } catch (e) {
    needs.push(inputNeed('draft.lines', String(e)));
  }
  const products = await getMany(
    ctx.assets,
    ProductSlot,
    draft.lines.flatMap((l) => (l.productRef ? [l.productRef.id] : [])),
  );
  const requirements: Requirement[] = [];
  let power = 0;
  let gas = false;
  let exhaust = false;
  for (const line of draft.lines) {
    const product = products.find((p) => p.id === line.productRef?.id);
    if (!product) continue;
    const u = product.data.utilities;
    power += (u?.powerKw ?? 0) * line.qty;
    gas ||= line.qty > 0 && !!u?.gas;
    exhaust ||= line.qty > 0 && !!u?.exhaust;
  }
  if (power > 0) {
    const factor = numberParam(ctx, 'site.powerDiversity', needs);
    if (factor !== null) {
      if (factor <= 0 || factor > 1)
        needs.push(inputNeed('params.site.powerDiversity', 'Expected factor in (0, 1]'));
      else
        requirements.push({
          key: 'powerCapacity',
          op: 'gte',
          value: power * factor,
          unit: 'kW',
          hard: true,
        });
    }
  }
  // present 只检查字段存在，false/none 仍存在，因此设备需求必须比较实际取值。
  if (gas) requirements.push({ key: 'gasService', op: 'eq', value: true, hard: true });
  if (exhaust)
    requirements.push({
      key: 'exhaustPath',
      op: 'in',
      value: ['existing', 'feasible'],
      hard: true,
    });
  const height = Math.max(0, ...draft.lines.map((l) => l.dimensionsMm?.h ?? 0));
  if (height)
    requirements.push({ key: 'clearHeight', op: 'gte', value: height, unit: 'mm', hard: true });
  for (const req of requirements) {
    const reading = site.body.conditions.find((c) => c.key === req.key);
    const check = meets(req, reading);
    if (check.value === null) needs.push(...check.needs);
    else if (!check.value) {
      const gate = await approval(
        ctx,
        'scaleToSite',
        `condition:${req.key}`,
        { requirement: req, reading, siteHash: site.hash },
        `场地 ${req.key} 不满足设备需求，确认调整方案后放行`,
        ['waive'],
      );
      if (!gate.accepted) needs.push(gate.need);
    }
  }
  addSources(
    draft,
    products.map((p) => assetRef(p)),
  );
  const upstream = [store, site].map((a) => ({ kind: a.kind, id: a.id, hash: a.hash }));
  draft.inputs = [...new Map([...draft.inputs, ...upstream].map((a) => [a.kind, a])).values()];
  if (store.storeId && site.storeId && store.storeId !== site.storeId)
    needs.push(inputNeed('site.storeId', 'Upstream artifacts refer to different stores'));
  draft.storeId = store.storeId ?? site.storeId ?? draft.storeId;
  return result(draft, needs);
}
export const scaleToSiteStep = {
  id: 'fitout-bom/scaleToSite',
  input: ScaleInput,
  output: BomDraft,
  reads: ['product'],
  params: [
    {
      key: 'site.powerDiversity',
      required: false,
      description: 'Equipment power diversity factor',
    },
  ],
  approval: { question: '确认场地条件调整', decision: z.literal('waive') },
  run: scaleToSite,
} satisfies StepDef<typeof ScaleInput, typeof BomDraft>;
