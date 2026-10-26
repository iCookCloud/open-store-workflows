import {
  AssetRef,
  AudienceRule,
  Campaign,
  CampaignVariant,
  type Need,
  type StepDef,
  StoreSlot,
  TemplateSlot,
  canonicalJson,
  getMany,
  matchesFilter,
  versionHash,
  z,
} from '@osw/core';
import { blocked, numericParam, queryAll, result } from './helpers.js';
import { Segmentation } from './models.js';
import {
  matchRule,
  narrowerThan,
  normalizeRule,
  normalizedValues,
  pickVariant,
  storeSubject,
} from './rule.js';
import { segmentRulesetSlot } from './slots.js';

type CampaignData = z.infer<typeof Campaign>;
export async function campaignContentHash(
  campaign: Pick<CampaignData, 'topicKey' | 'topicRule' | 'variants' | 'sharedBlocks'>,
): Promise<string> {
  return versionHash({
    topicKey: campaign.topicKey,
    topicRule: normalizeRule(campaign.topicRule),
    variants: campaign.variants.map((v) => ({ ...v, rule: normalizeRule(v.rule) })),
    sharedBlocks: campaign.sharedBlocks,
  });
}
export function lintNewsletterBody(body: string): string[] {
  const errors: string[] = [];
  if (/<!--[\s\S]*?-->/.test(body)) errors.push('HTML comments are forbidden');
  const tokens: string[] = body.match(/\{\{[^{}]+\}\}/g) ?? [];
  if (tokens.some((token) => !['{{UNSUB}}', '{{STORE}}', '{{STORE_URL}}'].includes(token)))
    errors.push('Unregistered newsletter placeholder');
  if (!tokens.includes('{{UNSUB}}')) errors.push('Newsletter must contain {{UNSUB}}');
  return errors;
}
function unionRules(
  a: z.infer<typeof AudienceRule>,
  b: z.infer<typeof AudienceRule>,
): z.infer<typeof AudienceRule> {
  const combined: z.infer<typeof AudienceRule> = {};
  for (const axis of ['tracks', 'regions', 'categories'] as const)
    if (a[axis] && b[axis]) combined[axis] = normalizedValues([...a[axis]!, ...b[axis]!]);
  return combined;
}
const Dimension = z.object({ key: z.string().min(1), values: z.array(z.string().min(1)).min(1) });
export const PlanCampaignInput = z.object({
  rulesetId: z.string().min(1),
  campaignId: z.string().min(1),
  sourceRef: z.string().optional(),
  supplierId: z.string().min(1),
  topicKey: z.string().min(1),
  topicRule: AudienceRule,
  dims: z.array(Dimension).min(1).max(3),
  variants: z.array(CampaignVariant).min(1),
  sharedBlocks: z.array(AssetRef),
  segmentation: Segmentation,
});
export const planCampaign: StepDef<typeof PlanCampaignInput, typeof Campaign> = {
  id: 'replenishment/planCampaign',
  input: PlanCampaignInput,
  output: Campaign,
  reads: ['template', 'segment-ruleset', 'store'],
  params: [
    { key: 'nl.matrix.maxDims', required: true, description: 'Maximum matrix dimensions' },
    { key: 'nl.matrix.minCell', required: true, description: 'Minimum audience per cell' },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const maxDims = numericParam(ctx, 'nl.matrix.maxDims', needs, {
      min: 1,
      max: 3,
      integer: true,
    });
    const minCell = numericParam(ctx, 'nl.matrix.minCell', needs, { min: 1, integer: true });
    const ruleset = await ctx.assets.get(segmentRulesetSlot, input.rulesetId);
    if (!ruleset)
      needs.push({
        kind: 'asset',
        slot: 'segment-ruleset',
        filter: null,
        reason: 'Segment ruleset not found',
        blocking: true,
      });
    if (ruleset?.redacted?.length)
      needs.push({
        kind: 'asset',
        slot: 'segment-ruleset',
        filter: null,
        reason: 'Campaign planning requires an unredacted ruleset',
        blocking: true,
      });
    if (needs.length || !ruleset || maxDims === null || minCell === null) return blocked(needs);
    if (input.dims.length > maxDims)
      needs.push({
        kind: 'input',
        path: 'dims',
        reason: 'Matrix exceeds the configured maximum dimensions',
        blocking: true,
      });
    if (
      new Set(input.dims.map((d) => d.key)).size !== input.dims.length ||
      new Set(input.variants.map((v) => v.variantKey)).size !== input.variants.length
    )
      needs.push({
        kind: 'input',
        path: 'variants',
        reason: 'Matrix dimensions and variant keys must be unique',
        blocking: true,
      });
    let dims = [...input.dims];
    let variants = input.variants.map((v) => ({
      ...v,
      cell: { ...v.cell },
      rule: normalizeRule(v.rule),
      expected: 0,
    }));
    for (const variant of variants) {
      if (!narrowerThan(variant.rule, input.topicRule, ruleset.data))
        needs.push({
          kind: 'input',
          path: `variants.${variant.variantKey}.rule`,
          reason: 'Variant rule widens the topic audience',
          blocking: true,
        });
      if (dims.some((dim) => !dim.values.includes(variant.cell[dim.key])))
        needs.push({
          kind: 'input',
          path: `variants.${variant.variantKey}.cell`,
          reason: 'Variant cell is not declared in the dimension order',
          blocking: true,
        });
    }
    if (needs.length) return blocked(needs);
    const stores = (
      await queryAll(ctx.assets, StoreSlot, { field: 'status', op: 'eq', value: 'operating' })
    ).filter((record) =>
      input.segmentation.segments.some((segment) => matchesFilter(record, segment.filter)),
    );
    if (stores.some((record) => record.redacted?.length))
      return blocked([
        {
          kind: 'asset',
          slot: 'store',
          filter: null,
          reason: 'Campaign sizing requires unredacted classification fields',
          blocking: true,
        },
      ]);
    const recount = () => {
      for (const v of variants) v.expected = 0;
      for (const store of stores) {
        const subject = storeSubject(store.data, ruleset.data);
        if (!matchRule(input.topicRule, subject, ruleset.data)) continue;
        const chosen = pickVariant(variants, subject, ruleset.data);
        if (chosen) chosen.expected++;
      }
    };
    recount();
    // 按声明顺序并相邻档；每轮减少格数或维数，保证终止与重放一致。
    for (let guard = 0; guard < input.variants.length + input.dims.length; guard++) {
      const smallest = [...variants]
        .filter((v) => v.expected < minCell)
        .sort((a, b) => a.expected - b.expected || (a.variantKey < b.variantKey ? -1 : 1))[0];
      if (!smallest) break;
      const last = dims.at(-1)!;
      const neighbors = variants
        .filter(
          (v) =>
            v !== smallest &&
            dims.slice(0, -1).every((d) => v.cell[d.key] === smallest.cell[d.key]),
        )
        .sort(
          (a, b) =>
            Math.abs(
              last.values.indexOf(a.cell[last.key]) - last.values.indexOf(smallest.cell[last.key]),
            ) -
              Math.abs(
                last.values.indexOf(b.cell[last.key]) -
                  last.values.indexOf(smallest.cell[last.key]),
              ) || (a.variantKey < b.variantKey ? -1 : 1),
        );
      if (neighbors.length && dims.length > 1) {
        const target = neighbors[0];
        target.rule = unionRules(target.rule, smallest.rule);
        target.cell[last.key] = [target.cell[last.key], smallest.cell[last.key]]
          .sort((a, b) => last.values.indexOf(a) - last.values.indexOf(b))
          .join('+');
        variants = variants.filter((v) => v !== smallest);
        recount();
        continue;
      }
      if (dims.length === 1) {
        variants = variants.filter((v) => v.expected >= minCell);
        break;
      }
      dims = dims.slice(0, -1);
      const merged = new Map<string, (typeof variants)[number]>();
      for (const variant of variants) {
        variant.cell = Object.fromEntries(dims.map((dim) => [dim.key, variant.cell[dim.key]]));
        const key = canonicalJson(variant.cell);
        const prior = merged.get(key);
        if (prior) prior.rule = unionRules(prior.rule, variant.rule);
        else merged.set(key, variant);
      }
      variants = [...merged.values()];
      recount();
    }
    if (!variants.length)
      return blocked([
        {
          kind: 'action',
          action: 'expandCampaignAudience',
          reason: 'No matrix cell reaches the minimum sample',
          blocking: true,
        },
      ]);
    variants.sort((a, b) => (a.variantKey < b.variantKey ? -1 : 1));
    for (let i = 0; i < variants.length; i++)
      for (let j = i + 1; j < variants.length; j++) {
        const a = variants[i];
        const b = variants[j];
        if (
          canonicalJson(a.lead) === canonicalJson(b.lead) ||
          (canonicalJson(a.productIds) === canonicalJson(b.productIds) &&
            canonicalJson(a.service) === canonicalJson(b.service) &&
            a.subject === b.subject)
        )
          needs.push({
            kind: 'input',
            path: 'variants',
            reason: 'Variants need distinct leads and another substantive content difference',
            blocking: true,
          });
      }
    const refs = [...input.sharedBlocks, ...variants.flatMap((v) => [v.lead, v.service])];
    const texts = new Map<string, string>();
    const blocks = await getMany(ctx.assets, TemplateSlot, [
      ...new Set(refs.filter((r) => r.slot === 'template').map((r) => r.id)),
    ]);
    const blocksById = new Map(blocks.map((r) => [r.id, r]));
    for (const ref of refs) {
      const record = ref.slot === 'template' ? blocksById.get(ref.id) : null;
      if (
        !record ||
        record.versionHash !== ref.versionHash ||
        record.data.kind !== 'newsletter-block' ||
        record.redacted?.length
      ) {
        needs.push({
          kind: 'asset',
          slot: 'template',
          filter: { field: 'id', op: 'eq', value: ref.id },
          reason: 'Newsletter block is missing, changed, or redacted',
          blocking: true,
        });
        continue;
      }
      const body = record.data.body;
      if (typeof body !== 'string') {
        needs.push({
          kind: 'input',
          path: `template.${ref.id}`,
          reason: 'Newsletter block requires a textual body',
          blocking: true,
        });
        continue;
      }
      texts.set(canonicalJson(ref), body);
    }
    for (const variant of variants) {
      const body = [variant.lead, variant.service, ...input.sharedBlocks]
        .map((ref) => texts.get(canonicalJson(ref)) ?? '')
        .join('\n');
      for (const reason of lintNewsletterBody(body))
        needs.push({
          kind: 'input',
          path: `variants.${variant.variantKey}`,
          reason,
          blocking: true,
        });
    }
    const data = {
      campaignId: input.sourceRef
        ? `source-${(await versionHash({ sourceRef: input.sourceRef, supplierId: input.supplierId })).slice(0, 32)}`
        : input.campaignId,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      supplierId: input.supplierId,
      topicKey: input.topicKey,
      topicRule: normalizeRule(input.topicRule),
      dims: dims.map((d) => d.key),
      variants,
      sharedBlocks: input.sharedBlocks,
      state: 'draft' as const,
    };
    return result({ ...data, contentHash: await campaignContentHash(data) }, needs);
  },
};
