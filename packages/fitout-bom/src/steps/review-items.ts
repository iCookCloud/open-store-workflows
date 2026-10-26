import {
  type BomLine,
  Currency,
  type Need,
  type StepCtx,
  type StepDef,
  assetRef,
  getMany,
  versionHash,
  z,
} from '@osw/core';
import { approval, assertVersion, inputNeed, result } from '../helpers.js';
import { generateComponents } from '../price/geometry.js';
import { BomDraft, ItemCandidate } from '../schema.js';
import { designSlot, lineTemplateSlot } from '../slots/index.js';
import { Identification } from './identify-items.js';
const Decision = z.object({
  action: z.enum(['accept', 'edit', 'merge', 'split', 'reject']),
  candidateIds: z.array(z.string()).min(1),
  outputs: z
    .array(z.object({ key: z.string().min(1), candidate: ItemCandidate, templateId: z.string() }))
    .default([]),
});
export const ReviewInput = z.object({
  identification: Identification,
  decisions: z.array(Decision),
  currency: Currency,
  storeId: z.string().nullable().default(null),
  example: z.literal(true).optional(),
});
export async function reviewItems(raw: z.infer<typeof ReviewInput>, ctx: StepCtx) {
  const input = ReviewInput.parse(raw);
  const needs: Need[] = [];
  const design = await ctx.assets.get(designSlot, input.identification.designRef.id);
  if (!assertVersion(design ?? undefined, input.identification.designRef, needs))
    return result(null, needs);
  input.identification.imageAiFlags = design!.data.images.map((image) => image.aiGenerated);
  const candidates = new Map(input.identification.candidates.map((c) => [c.tempId, c]));
  const used = new Set<string>();
  const templates = await getMany(
    ctx.assets,
    lineTemplateSlot,
    input.decisions.flatMap((d) => d.outputs.map((o) => o.templateId)),
  );
  const lines: BomLine[] = [];
  for (const decision of input.decisions) {
    for (const id of decision.candidateIds) {
      if (!candidates.has(id) || used.has(id))
        needs.push(inputNeed('decisions', 'Each candidate must be reviewed exactly once'));
      used.add(id);
    }
    const expected = decision.action === 'reject' ? 0 : decision.action === 'split' ? 2 : 1;
    if (
      decision.action === 'split'
        ? decision.outputs.length < expected
        : decision.outputs.length !== expected
    )
      needs.push(inputNeed('decisions.outputs', 'Invalid output count for review action'));
    if (decision.action !== 'merge' && decision.candidateIds.length !== 1)
      needs.push(
        inputNeed('decisions.candidateIds', 'Only merge accepts multiple source candidates'),
      );
    if (decision.action === 'merge' && decision.candidateIds.length < 2)
      needs.push(inputNeed('decisions.candidateIds', 'Merge requires at least two candidates'));
    if (new Set(decision.outputs.map((o) => o.key)).size !== decision.outputs.length)
      needs.push(inputNeed('decisions.outputs', 'Output keys must be unique'));
    for (const output of decision.outputs) {
      const candidate = output.candidate;
      const template = templates.find((t) => t.id === output.templateId);
      if (!template) {
        needs.push(inputNeed(`templates.${output.templateId}`, 'Template not found'));
        continue;
      }
      if (template.data.lineKind !== candidate.lineKind)
        needs.push(inputNeed('templateId', 'Template line kind differs from candidate'));
      const sourceEvidence = decision.candidateIds.flatMap(
        (id) => candidates.get(id)?.evidence ?? [],
      );
      const evidence = [
        ...new Map(
          [...sourceEvidence, ...candidate.evidence].map((e) => [JSON.stringify(e), e]),
        ).values(),
      ];
      if (evidence.some((e) => input.identification.imageAiFlags[e.imageIndex] === undefined)) {
        needs.push(inputNeed('evidence', 'Invalid image index'));
        continue;
      }
      const aiOnly = evidence.every((e) => input.identification.imageAiFlags[e.imageIndex]);
      let components =
        candidate.pricingMode === 'custom' ? structuredClone(template.data.components) : [];
      let warnings: string[] = [];
      if (candidate.pricingMode === 'custom') {
        if (!candidate.dimensionsMm && template.data.shape !== 'components') {
          needs.push(
            inputNeed(
              `candidates.${candidate.tempId}.dimensionsMm`,
              'Geometry requires dimensions',
            ),
          );
          continue;
        }
        try {
          const generated = generateComponents({
            shape: template.data.shape,
            dimensionsMm: candidate.dimensionsMm ?? { l: 0, w: 0, h: 0 },
            ...template.data.defaults,
            components,
          });
          components = generated.components;
          warnings = generated.warnings;
        } catch (e) {
          needs.push(inputNeed(`templates.${template.id}`, String(e)));
          continue;
        }
      }
      const id = `line-${(await versionHash({ design: input.identification.designRef.id, candidates: [...decision.candidateIds].sort(), key: output.key })).slice(0, 20)}`;
      lines.push({
        id,
        lineKind: candidate.lineKind,
        qty: candidate.qty,
        unit: candidate.unit,
        category: template.data.category,
        name: candidate.name,
        zone: candidate.zone,
        spec: candidate.spec,
        dimensionsMm: candidate.dimensionsMm,
        qtyRule: { kind: 'manual' },
        qtyBasis: {
          status: aiOnly || candidate.estimated.qty ? 'estimated' : 'manual',
          note: candidate.note,
        },
        dimsBasis: {
          status: aiOnly || candidate.estimated.dims ? 'estimated' : 'manual',
          note: candidate.note,
        },
        budgetKey: template.data.budgetKey,
        evidence: evidence.map((e) => ({
          image: { ...input.identification.designRef, path: `/images/${e.imageIndex}` },
          frame: e.frame,
          note: aiOnly ? 'AI-generated image; not measurement evidence' : candidate.note,
        })),
        derivedFrom: { kind: 'image', ref: decision.candidateIds.join(',') },
        pricingMode: candidate.pricingMode,
        components,
        modelCostPerUnit: null,
        parts: [],
        modelWarnings: warnings,
        sourcing: null,
        costBasis: 'model',
        unitPrice: { amount: 0, currency: input.currency, basis: 'estimate' },
      });
    }
  }
  if (used.size !== candidates.size)
    needs.push(inputNeed('decisions', 'Some candidates have not been reviewed'));
  const draft = BomDraft.parse({
    currency: input.currency,
    storeId: input.storeId,
    lines,
    sources: [input.identification.designRef, ...templates.map((t) => assetRef(t))],
    inputs: [],
    example: input.example,
  });
  const gate = await approval(
    ctx,
    'reviewItems',
    'draft',
    { identification: input.identification, decisions: input.decisions, draft },
    '确认识图清单、合并拆分与所有估算字段',
    ['approve'],
  );
  if (!gate.accepted) needs.push(gate.need);
  return result(draft, needs);
}
export const reviewItemsStep = {
  id: 'fitout-bom/reviewItems',
  input: ReviewInput,
  output: BomDraft,
  reads: ['design', 'line-template'],
  params: [],
  approval: { question: '确认识图清单', decision: z.literal('approve') },
  run: reviewItems,
} satisfies StepDef<typeof ReviewInput, typeof BomDraft>;
