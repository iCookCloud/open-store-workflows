import { type StepCtx, type StepDef, assetRef, versionHash, z } from '@osw/core';
import { result } from '../helpers.js';
import { BomDraft } from '../schema.js';
import { bomCaseSlot } from '../slots/index.js';
export const SeedInput = z.object({
  caseId: z.string(),
  storeId: z.string().nullable().default(null),
});
export async function seedFromCase(raw: z.infer<typeof SeedInput>, ctx: StepCtx) {
  const input = SeedInput.parse(raw);
  const record = await ctx.assets.get(bomCaseSlot, input.caseId);
  if (!record)
    return result(null, [
      {
        kind: 'asset',
        slot: bomCaseSlot.name,
        filter: { field: 'id', op: 'eq', value: input.caseId },
        reason: 'BOM case not found',
        blocking: true,
      },
    ]);
  const ids = new Map<string, string>();
  for (const line of record.data.lines)
    ids.set(
      line.id,
      `line-${(await versionHash({ caseId: record.id, lineId: line.id, storeId: input.storeId })).slice(0, 20)}`,
    );
  const lines = record.data.lines.map((original) => {
    const { offerRef, sourcing, ...line } = structuredClone(original);
    return {
      ...line,
      id: ids.get(line.id)!,
      qtyRule:
        line.qtyRule.kind === 'linked'
          ? { ...line.qtyRule, links: line.qtyRule.links.map((id) => ids.get(id) ?? id) }
          : line.qtyRule,
      derivedFrom: { kind: 'case' as const, ref: `${record.id}#${line.id}` },
      modelCostPerUnit: null,
      parts: [],
      modelWarnings: [],
      sourcing: null,
      costBasis: 'model' as const,
      unitPrice: { amount: 0, currency: line.unitPrice.currency, basis: 'estimate' as const },
    };
  });
  const currency = lines[0]?.unitPrice.currency ?? record.data.referenceTotal?.currency;
  if (!currency)
    return result(null, [
      {
        kind: 'input',
        path: 'case.currency',
        reason: 'Empty case has no currency',
        blocking: true,
      },
    ]);
  return result(
    BomDraft.parse({
      currency,
      lines,
      sources: [assetRef(record), ...record.data.designRefs],
      inputs: [],
      storeId: input.storeId,
      example: record.example,
    }),
  );
}
export const seedFromCaseStep = {
  id: 'fitout-bom/seedFromCase',
  input: SeedInput,
  output: BomDraft,
  reads: ['bom-case'],
  params: [],
  run: seedFromCase,
} satisfies StepDef<typeof SeedInput, typeof BomDraft>;
