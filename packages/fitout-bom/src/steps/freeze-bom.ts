import {
  ArtifactEnvelope,
  BomBody,
  type BomLine,
  type Need,
  SHARED_SLOTS,
  type SlotDef,
  type StepCtx,
  type StepDef,
  type Verification,
  getMany,
  roundMoney,
  versionHash,
  z,
} from '@osw/core';
import { approval, inputNeed, result } from '../helpers.js';
import { BomDraft } from '../schema.js';
import { slots } from '../slots/index.js';
import { priceModel } from './price-model.js';
import { SiteDecision, StoreSpec, scaleToSite } from './scale-to-site.js';
import { sourceLines } from './source-lines.js';
export const Bom = ArtifactEnvelope('Bom', BomBody);
export const FreezeInput = z.object({ draft: BomDraft, store: StoreSpec, site: SiteDecision });
export function calculateTotals(
  lines: readonly BomLine[],
  currency: string,
): z.infer<typeof BomBody>['totals'] {
  const sum = (list: readonly BomLine[], kind: 'model' | 'chosen') =>
    roundMoney({
      amount: list.reduce(
        (s, l) =>
          s +
          roundMoney({
            amount: l.qty * (kind === 'model' ? l.modelCostPerUnit!.amount : l.unitPrice.amount),
            currency,
          }).amount,
        0,
      ),
      currency,
    });
  const byBudgetKey: z.infer<typeof BomBody>['totals']['byBudgetKey'] = {};
  for (const key of new Set(lines.map((l) => l.budgetKey))) {
    const group = lines.filter((l) => l.budgetKey === key);
    const amount = group.reduce((s, l) => s + l.qty, 0);
    byBudgetKey[key] = {
      model: sum(group, 'model'),
      chosen: sum(group, 'chosen'),
      sourcedShare:
        amount === 0
          ? 1
          : group.filter((l) => l.sourcing !== null).reduce((s, l) => s + l.qty, 0) / amount,
    };
  }
  return { model: sum(lines, 'model'), chosen: sum(lines, 'chosen'), byBudgetKey };
}
export async function freezeBom(raw: z.infer<typeof FreezeInput>, ctx: StepCtx) {
  const { draft, store, site } = FreezeInput.parse(raw);
  const needs: Need[] = [];
  const verifications: Verification[] = [];
  for (const artifact of [store, site])
    if ((await versionHash(artifact.body)) !== artifact.hash)
      needs.push(inputNeed(`inputs.${artifact.kind}.hash`, 'Upstream artifact hash is invalid'));
  for (const line of draft.lines) {
    if (!line.productRef)
      needs.push(inputNeed(`lines.${line.id}.productRef`, 'Every frozen line requires a product'));
    if (!line.modelCostPerUnit)
      needs.push(
        inputNeed(
          `lines.${line.id}.modelCostPerUnit`,
          'Complete the model before freezing; missing costs cannot count as zero',
        ),
      );
  }
  if (!draft.lines.length) needs.push(inputNeed('draft.lines', 'Cannot freeze an empty BOM'));
  const definitions = new Map<string, SlotDef>([...SHARED_SLOTS, ...slots].map((s) => [s.name, s]));
  for (const slotName of new Set(draft.sources.map((r) => r.slot))) {
    const refs = draft.sources.filter((r) => r.slot === slotName);
    const slot = definitions.get(slotName);
    if (!slot) {
      needs.push(inputNeed(`sources.${slotName}`, 'Unknown asset slot'));
      continue;
    }
    const records = await getMany(
      ctx.assets,
      slot,
      refs.map((r) => r.id),
    );
    for (const ref of refs) {
      const r = records.find((x) => x.id === ref.id);
      const hash = ref.fieldset ? r?.fieldsetHashes?.[ref.fieldset] : r?.versionHash;
      if (hash !== ref.versionHash)
        needs.push(
          inputNeed(
            `sources.${slotName}.${ref.id}`,
            'Source changed or disappeared; rebuild BOM and approvals',
          ),
        );
    }
  }
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const scaled = await scaleToSite({ draft, store, site }, ctx);
  needs.push(...scaled.needs);
  if (scaled.output?.lines.some((l, i) => l.qty !== draft.lines[i].qty))
    needs.push(inputNeed('draft.lines.qty', 'Re-run site scaling before freeze'));
  const priced = await priceModel({ draft }, ctx);
  needs.push(...priced.needs);
  if (
    priced.output &&
    (await versionHash(
      priced.output.lines.map((l) => ({ model: l.modelCostPerUnit, parts: l.parts })),
    )) !==
      (await versionHash(draft.lines.map((l) => ({ model: l.modelCostPerUnit, parts: l.parts }))))
  )
    needs.push(
      inputNeed(
        'draft.lines.modelCostPerUnit',
        'Model no longer matches referenced rates; reprice before freeze',
      ),
    );
  const sourced = await sourceLines({ draft, openingTarget: site.body.openingTarget }, ctx);
  needs.push(...sourced.needs);
  if (
    sourced.output &&
    (await versionHash(sourced.output.draft.lines)) !== (await versionHash(draft.lines))
  )
    needs.push(
      inputNeed(
        'draft.lines.sourcing',
        'Selected offer snapshot changed; source again before freeze',
      ),
    );
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const body = BomBody.parse({
    currency: draft.currency,
    lines: draft.lines,
    totals: calculateTotals(draft.lines, draft.currency),
  });
  const hash = await versionHash(body);
  const estimated = draft.lines
    .filter(
      (l) =>
        l.qtyBasis.status === 'estimated' ||
        l.dimsBasis.status === 'estimated' ||
        (l.derivedFrom.kind === 'menu' && l.lineKind === 'equipment'),
    )
    .map((l) => l.id);
  const gate = await approval(
    ctx,
    'freezeBom',
    'bom',
    body,
    `确认物料单定稿。需复核估算尺寸、数量或设备台数的行：${estimated.join(', ') || '无'}`,
    ['approve'],
  );
  if (!gate.accepted) needs.push(gate.need);
  for (const budget of store.body.economics.investment) {
    const actual = body.totals.byBudgetKey[budget.key];
    if (!actual || !budget.range) continue;
    const high = budget.range.high;
    const low = budget.range.low;
    if (high.currency !== draft.currency || low.currency !== draft.currency) {
      needs.push(inputNeed('store.economics.investment', 'Budget currency differs from BOM'));
      continue;
    }
    verifications.push({
      asset: store.body.economics.template,
      purpose: 'fitout-bom/freezeBom',
      dimension: `budget.${budget.key}`,
      verdict:
        actual.sourcedShare < 1
          ? 'pending'
          : actual.chosen.amount <= high.amount && actual.chosen.amount >= low.amount
            ? 'holds'
            : 'fails',
      reason:
        actual.sourcedShare < 1
          ? 'Not all budget lines have a supplier quote'
          : 'Chosen amount compared with investment interval',
      measured: {
        field: `investment.${budget.key}`,
        expected: high.amount,
        actual: actual.chosen.amount,
        unit: draft.currency,
        delta: actual.chosen.amount - high.amount,
      },
      by: ctx.actor,
      at: ctx.now,
    });
  }
  return result(
    Bom.parse({
      kind: 'Bom',
      artifactVersion: '0.1.0',
      id: `bom-${hash}`,
      hash,
      producedBy: { step: 'fitout-bom/freezeBom', pkg: '@osw/fitout-bom', pkgVersion: '0.1.0' },
      storeId: draft.storeId,
      inputs: [
        { kind: store.kind, id: store.id, hash: store.hash },
        { kind: site.kind, id: site.id, hash: site.hash },
      ],
      sources: draft.sources,
      createdAt: ctx.now,
      example: draft.example,
      body,
    }),
    needs,
    verifications,
  );
}
export const freezeBomStep = {
  id: 'fitout-bom/freezeBom',
  input: FreezeInput,
  output: Bom,
  reads: [
    'product',
    'offer',
    'party',
    'material-rate',
    'design',
    'line-template',
    'bom-case',
    'menu',
    'recipe',
  ],
  params: [],
  approval: { question: '确认物料单定稿', decision: z.literal('approve') },
  run: freezeBom,
} satisfies StepDef<typeof FreezeInput, typeof Bom>;
