import { type Need, type StepCtx, type StepResult, type WorkflowModule, z } from '@osw/core';
import { BomDraft } from './schema.js';
import { slots } from './slots/index.js';
import { DeriveInput, deriveMenuLines, deriveMenuLinesStep } from './steps/derive-menu-lines.js';
import { freezeBom, freezeBomStep } from './steps/freeze-bom.js';
import { IdentifyInput, identifyItems, identifyItemsStep } from './steps/identify-items.js';
import { priceModel, priceModelStep } from './steps/price-model.js';
import { quoteBomStep } from './steps/quote-bom.js';
import { resolveProducts, resolveProductsStep } from './steps/resolve-products.js';
import { ReviewInput, reviewItems, reviewItemsStep } from './steps/review-items.js';
import { SiteDecision, StoreSpec, scaleToSite, scaleToSiteStep } from './steps/scale-to-site.js';
import { SeedInput, seedFromCase, seedFromCaseStep } from './steps/seed-from-case.js';
import { sourceLines, sourceLinesStep } from './steps/source-lines.js';
import { verifyOffers, verifyOffersStep } from './steps/verify-offers.js';
export const RunInput = z
  .object({
    draft: BomDraft.optional(),
    seed: SeedInput.optional(),
    identify: IdentifyInput.optional(),
    review: ReviewInput.omit({ identification: true }).optional(),
    store: StoreSpec,
    site: SiteDecision,
    menu: DeriveInput.omit({ draft: true, store: true }).optional(),
  })
  .refine((v) => [v.draft, v.seed, v.identify].filter(Boolean).length === 1, {
    message: 'Provide exactly one start: draft, seed or identify',
  });
export async function run(raw: unknown, ctx: StepCtx) {
  const input = RunInput.parse(raw);
  const steps: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  const capture = <T>(name: string, r: StepResult<T>) => {
    steps[name] = r;
    needs.push(...r.needs);
    return r.output;
  };
  const stopped = () => ({ steps, artifact: null, needs });
  let draft = input.draft;
  if (input.seed) {
    const output = capture('seedFromCase', await seedFromCase(input.seed, ctx));
    if (!output) return stopped();
    draft = output;
  }
  if (input.identify) {
    const identification = capture('identifyItems', await identifyItems(input.identify, ctx));
    if (!identification) return stopped();
    if (!input.review) {
      needs.push({
        kind: 'input',
        path: 'review',
        reason: 'Review decisions are required for identified candidates',
        blocking: true,
      });
      return stopped();
    }
    const output = capture(
      'reviewItems',
      await reviewItems({ ...input.review, identification }, ctx),
    );
    if (!output) return stopped();
    draft = output;
  }
  if (!draft) throw new Error('No workflow start');
  const scaled = capture(
    'scaleToSite',
    await scaleToSite({ draft, store: input.store, site: input.site }, ctx),
  );
  if (!scaled) return stopped();
  draft = scaled;
  const derived = capture(
    'deriveMenuLines',
    await deriveMenuLines({ draft, store: input.store, ...input.menu }, ctx),
  );
  if (!derived) return stopped();
  draft = derived;
  const resolved = capture('resolveProducts', await resolveProducts({ draft }, ctx));
  if (!resolved) return stopped();
  draft = resolved;
  // 菜单和产品解析会增加设备需求，必须再次核对场地后才能采购。
  const checked = capture(
    'scaleToSite',
    await scaleToSite({ draft, store: input.store, site: input.site }, ctx),
  );
  if (!checked) return stopped();
  draft = checked;
  const priced = capture('priceModel', await priceModel({ draft }, ctx));
  if (!priced) return stopped();
  draft = priced;
  const sourced = capture(
    'sourceLines',
    await sourceLines({ draft, openingTarget: input.site.body.openingTarget }, ctx),
  );
  if (!sourced) return stopped();
  const verified = capture('verifyOffers', await verifyOffers(sourced, ctx));
  if (!verified) return stopped();
  const artifact = capture(
    'freezeBom',
    await freezeBom({ draft: verified.draft, store: input.store, site: input.site }, ctx),
  );
  return { steps, artifact, needs };
}
export const workflow: WorkflowModule = {
  key: 'fitout-bom',
  version: '0.1.0',
  slots,
  steps: [
    seedFromCaseStep,
    identifyItemsStep,
    reviewItemsStep,
    scaleToSiteStep,
    deriveMenuLinesStep,
    resolveProductsStep,
    priceModelStep,
    sourceLinesStep,
    verifyOffersStep,
    freezeBomStep,
    quoteBomStep,
  ],
  run,
};
