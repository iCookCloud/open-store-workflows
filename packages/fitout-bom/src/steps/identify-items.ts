import { AssetRef, type StepCtx, type StepDef, assetRef, versionHash, z } from '@osw/core';
import { inputNeed, result } from '../helpers.js';
import { ITEMIZE_PROMPT_VERSION, importedItemizer } from '../providers/index.js';
import { ItemCandidate } from '../schema.js';
import { designSlot } from '../slots/index.js';
export const Identification = z.object({
  designRef: AssetRef,
  candidates: z.array(ItemCandidate).max(2000),
  imageAiFlags: z.array(z.boolean()),
});
export const IdentifyInput = z.object({
  designId: z.string().min(1),
  track: z.string().min(1),
  zones: z.array(z.string()).optional(),
  candidates: z.union([z.array(ItemCandidate), z.string()]).optional(),
});
export async function identifyItems(raw: z.infer<typeof IdentifyInput>, ctx: StepCtx) {
  const input = IdentifyInput.parse(raw);
  const design = await ctx.assets.get(designSlot, input.designId);
  const provider =
    input.candidates === undefined ? ctx.providers.itemizer : importedItemizer(input.candidates);
  if (!design)
    return result(null, [
      {
        kind: 'asset',
        slot: designSlot.name,
        filter: { field: 'id', op: 'eq', value: input.designId },
        reason: 'Design not found',
        blocking: true,
      },
    ]);
  if (!provider)
    return result(null, [
      {
        kind: 'provider',
        name: 'itemizer',
        reason: 'Configure an imported or remote itemizer',
        blocking: true,
      },
    ]);
  const images = design.data.images.map((im, index) => ({ ...im, index }));
  const request = {
    images,
    track: input.track,
    zones: input.zones,
    promptVersion: ITEMIZE_PROMPT_VERSION,
  };
  const key = await versionHash({
    ...request,
    provider: provider.id,
    model: provider.model,
    cacheIdentity: provider.cacheIdentity,
  });
  const cached = await ctx.stores?.cache.get(key);
  let candidates: ItemCandidate[];
  if (cached !== undefined && cached !== null)
    candidates = ItemCandidate.array().max(2000).parse(cached);
  else {
    const zones =
      provider.id === 'imported' ? [undefined] : input.zones?.length ? input.zones : [undefined];
    candidates = [];
    for (const zone of zones) {
      if (provider.quota) {
        if (!ctx.stores)
          return result(null, [
            {
              kind: 'provider',
              name: 'quota',
              reason: 'Remote itemization requires an atomic quota store',
              blocking: true,
            },
          ]);
        if (
          !(await ctx.stores.quota.consume(
            'fitout-bom/identifyItems',
            provider.id,
            provider.quota.limit,
            provider.quota.windowSec,
          ))
        )
          return result(null, [
            {
              kind: 'provider',
              name: 'itemizer',
              reason: 'Itemizer quota exhausted',
              blocking: true,
            },
          ]);
      }
      const batch = ItemCandidate.array()
        .max(provider.id === 'imported' ? 2000 : 500)
        .parse(await provider.itemize({ ...request, zones: zone ? [zone] : undefined }));
      candidates.push(...batch);
    }
    if (candidates.length > 2000)
      return result(null, [inputNeed('zones', 'More than 2000 items; split the project')]);
  }
  if (new Set(candidates.map((c) => c.tempId)).size !== candidates.length)
    return result(null, [
      inputNeed('candidates', 'Duplicate candidate IDs; merge overlapping zones explicitly'),
    ]);
  if (candidates.some((c) => c.evidence.some((e) => !images[e.imageIndex])))
    return result(null, [inputNeed('candidates.evidence', 'Image index is outside the design')]);
  if (cached === undefined || cached === null) await ctx.stores?.cache.put(key, candidates, 86400);
  candidates = candidates.map((c) =>
    c.evidence.every((e) => images[e.imageIndex].aiGenerated)
      ? { ...c, estimated: { dims: true, qty: true } }
      : c,
  );
  return result(
    Identification.parse({
      designRef: assetRef(design),
      candidates,
      imageAiFlags: images.map((i) => i.aiGenerated),
    }),
  );
}
export const identifyItemsStep = {
  id: 'fitout-bom/identifyItems',
  input: IdentifyInput,
  output: Identification,
  reads: ['design'],
  params: [],
  run: identifyItems,
} satisfies StepDef<typeof IdentifyInput, typeof Identification>;
