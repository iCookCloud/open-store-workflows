import {
  ArtifactEnvelope,
  type AssetReader,
  type AssetRecordOf,
  type AssetRef,
  BomBody,
  Campaign,
  type Need,
  OpeningRecordBody,
  type ParamReader,
  type StepCtx,
  type StepDef,
  type StepResult,
  SupplyProgramBody,
  type WorkflowModule,
  assetRef,
  versionHash,
  z,
} from '@osw/core';
import { admitFromOpening } from './admit.js';
import { selectAudience } from './audience.js';
import { PlanCampaignInput, planCampaign } from './campaign.js';
import { classifyStores } from './classify.js';
import { ingestEvents } from './events.js';
import { blocked, inputNeeds, numericParam, queryAll, result } from './helpers.js';
import { matchSuppliers } from './match.js';
import { reorderSlot } from './models-reorder.js';
import { advanceReorder, draftReorder, frequentList } from './reorder.js';
import { computeReplenishShare } from './share.js';
import { campaignSlots, segmentRulesetSlot } from './slots.js';
import { decideSend } from './throttle.js';
import { verifyUpstream } from './verify.js';

const Opening = ArtifactEnvelope('OpeningRecord', OpeningRecordBody);
const Bom = ArtifactEnvelope('Bom', BomBody);
export const SupplyProgram = ArtifactEnvelope('SupplyProgram', SupplyProgramBody);
const Common = z.object({
  rulesetId: z.string().min(1),
  programId: z.string().min(1).max(128).optional(),
  opening: Opening.optional(),
  bom: Bom.optional(),
  verification: verifyUpstream.input.optional(),
});
export const RunInput = z.discriminatedUnion('mode', [
  Common.extend({
    mode: z.literal('campaign'),
    campaign: PlanCampaignInput.omit({ rulesetId: true, segmentation: true }),
    previousCampaign: Campaign.optional(),
    domainBreakerFrom: z.string().optional(),
    webhookReady: z.boolean().optional(),
  }),
  Common.extend({
    mode: z.literal('reorder'),
    storeId: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    selected: draftReorder.input.shape.selected,
    action: z.enum(['submit', 'confirm', 'cancel']).optional(),
  }),
]);

const BatchInput = z.object({
  orders: draftReorder.output.shape.orders,
  action: z.enum(['submit', 'confirm', 'cancel']),
});
const BatchOutput = z.object({ orders: z.array(advanceReorder.output) });
export const advanceReorders: StepDef<typeof BatchInput, typeof BatchOutput> = {
  id: 'replenishment/advanceReorders',
  input: BatchInput,
  output: BatchOutput,
  reads: advanceReorder.reads,
  params: advanceReorder.params,
  async run(input, ctx) {
    const orders: z.infer<typeof advanceReorder.output>[] = [];
    const needs: Need[] = [];
    const verifications: StepResult<unknown>['verifications'] = [];
    for (const order of input.orders) {
      const advanced = await advanceReorder.run({ ...order, action: input.action }, ctx);
      needs.push(...advanced.needs);
      verifications.push(...advanced.verifications);
      if (advanced.output) orders.push(advanced.output);
    }
    return result({ orders }, needs, verifications);
  },
};

export const steps = [
  admitFromOpening,
  classifyStores,
  matchSuppliers,
  planCampaign,
  selectAudience,
  decideSend,
  ingestEvents,
  frequentList,
  draftReorder,
  advanceReorder,
  advanceReorders,
  verifyUpstream,
  computeReplenishShare,
] as const;
export const slots = [...campaignSlots, reorderSlot];

// 只保留规则与选用资产的出处；逐店联系人和发送台账不进入长期产出物。
function observedContext(ctx: StepCtx) {
  const sources = new Map<string, z.infer<typeof AssetRef>>();
  const included = new Set([
    'params',
    'segment-ruleset',
    'offer',
    'menu',
    'recipe',
    'template',
    'product',
    'party',
  ]);
  let synthetic = true;
  const observe = (record: AssetRecordOf<unknown>) => {
    synthetic &&= record.example === true;
    if (included.has(record.slot)) {
      const ref = assetRef(record);
      sources.set(JSON.stringify(ref), ref);
    }
  };
  const assets: AssetReader = {
    async get(slot, id) {
      const record = await ctx.assets.get(slot, id);
      if (record) observe(record);
      return record;
    },
    async query(slot, filter, options) {
      const page = await ctx.assets.query(slot, filter, options);
      page.items.forEach(observe);
      return page;
    },
    ...(ctx.assets.count ? { count: ctx.assets.count.bind(ctx.assets) } : {}),
  };
  const params: ParamReader = {
    ...ctx.params,
    get(key, scope) {
      const value = ctx.params.get(key, scope);
      if (value !== undefined) {
        const refs = ctx.params.refs?.(key, scope) ?? [];
        if (!refs.length) synthetic = false;
        for (const ref of refs) sources.set(JSON.stringify(ref), ref);
      }
      return value;
    },
  };
  return {
    ctx: { ...ctx, assets, params },
    sources: () =>
      [...sources.values()].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    synthetic: () => synthetic,
  };
}

export async function run(raw: unknown, initialCtx: StepCtx) {
  const outputs: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  const stop = () => ({ steps: outputs, artifact: null, needs });
  const parsed = RunInput.safeParse(raw);
  if (!parsed.success) {
    needs.push(...inputNeeds(parsed.error));
    return stop();
  }
  const input = parsed.data;
  if (!!input.opening !== !!input.bom) {
    needs.push({
      kind: 'input',
      path: 'opening',
      reason: 'OpeningRecord and Bom must be supplied together',
      blocking: true,
    });
    return stop();
  }
  if (input.mode === 'reorder' && input.opening && input.opening.storeId !== input.storeId) {
    needs.push({
      kind: 'input',
      path: 'storeId',
      reason: 'Opening handoff must belong to the reorder store',
      blocking: true,
    });
    return stop();
  }
  const observed = observedContext(initialCtx);
  const ctx = observed.ctx;
  const invoke = async <I extends z.ZodType, O extends z.ZodType>(
    step: StepDef<I, O>,
    value: z.infer<I>,
  ): Promise<z.infer<O> | null> => {
    const parsed = step.input.safeParse(value);
    const output: StepResult<z.infer<O>> = parsed.success
      ? await step.run(parsed.data, ctx)
      : blocked(inputNeeds(parsed.error));
    outputs[step.id] = output;
    needs.push(...output.needs);
    return output.output;
  };
  const admission =
    input.opening && input.bom
      ? await invoke(admitFromOpening, { opening: input.opening, bom: input.bom })
      : undefined;
  if (admission === null) return stop();
  const segmentation = await invoke(classifyStores, { rulesetId: input.rulesetId });
  if (!segmentation) return stop();
  const matches = await invoke(matchSuppliers, { segments: segmentation.segments });
  if (!matches) return stop();
  const campaigns: z.infer<typeof SupplyProgramBody>['campaigns'] = [];
  if (input.mode === 'campaign') {
    const matching = matches.find((match) => match.supplierId === input.campaign.supplierId);
    if (!matching?.segments.length) {
      needs.push({
        kind: 'action',
        action: 'matchRepeatSupplier',
        ref: input.campaign.supplierId,
        reason: 'Supplier has no eligible operating-store segment and active repeat offer',
        blocking: true,
      });
      return stop();
    }
    const eligible = segmentation.segments.filter((segment) =>
      matching.segments.some((match) => match.key === segment.key),
    );
    let campaign = await invoke(planCampaign, {
      ...input.campaign,
      rulesetId: input.rulesetId,
      segmentation: {
        total: eligible.reduce((sum, segment) => sum + segment.count, 0),
        segments: eligible,
        unclassified: { count: 0, byMissing: {}, sample: [] },
      },
    });
    if (!campaign) return stop();
    if (input.previousCampaign) {
      if (input.previousCampaign.campaignId !== campaign.campaignId) {
        needs.push({
          kind: 'input',
          path: 'previousCampaign',
          reason: 'Previous campaign must refer to the same campaign ID',
          blocking: true,
        });
        return stop();
      }
      if (input.previousCampaign.contentHash === campaign.contentHash)
        campaign = {
          ...campaign,
          state: input.previousCampaign.state,
          ...(input.previousCampaign.breakerFrom
            ? { breakerFrom: input.previousCampaign.breakerFrom }
            : {}),
        };
    }
    const audience = await invoke(selectAudience, { campaign, rulesetId: input.rulesetId });
    if (!audience) return stop();
    const decision = await invoke(decideSend, {
      campaign,
      webhookReady: input.webhookReady,
      domainBreakerFrom: input.domainBreakerFrom,
    });
    if (!decision) return stop();
    campaigns.push({
      ...campaign,
      state:
        campaign.state === 'done'
          ? 'done'
          : decision.decision === 'send'
            ? 'approved'
            : decision.decision === 'hold'
              ? 'held'
              : 'paused',
      ...(decision.breakerFrom ? { breakerFrom: decision.breakerFrom } : {}),
      stats: decision.stats,
    });
  } else {
    const frequent = await invoke(frequentList, {
      storeId: input.storeId,
      ...(admission ? { openedAt: admission.openedAt, seedLines: admission.seedLines } : {}),
    });
    if (!frequent) return stop();
    const drafted = await invoke(draftReorder, {
      storeId: input.storeId,
      currency: input.currency,
      selected: input.selected,
    });
    if (!drafted) return stop();
    if (
      input.action &&
      !(await invoke(advanceReorders, { orders: drafted.orders, action: input.action }))
    )
      return stop();
  }
  if (input.verification && !(await invoke(verifyUpstream, input.verification))) return stop();
  const target = numericParam(ctx, 'program.shareTarget', needs, { min: 0, max: 1 });
  if (target === null) return stop();
  let replenishShare: z.infer<typeof SupplyProgramBody>['replenishShare'] =
    segmentation.segments.map((segment) => ({
      segmentKey: segment.key,
      basis: 'none',
      stores: segment.count,
      byLines: null,
      target,
    }));
  if (admission) {
    const segment = [...segmentation.segments]
      .sort((a, b) => b.region.length - a.region.length)
      .find(
        (segment) =>
          segment.track === input.opening?.body.track &&
          (input.opening.body.jurisdiction === segment.region ||
            input.opening.body.jurisdiction.startsWith(`${segment.region}-`)),
      );
    if (segment) {
      const share = await invoke(computeReplenishShare, {
        stores: [
          { storeId: admission.storeId, segmentKey: segment.key, seedLines: admission.seedLines },
        ],
      });
      if (!share) return stop();
      replenishShare = replenishShare.flatMap((row) =>
        row.segmentKey !== segment.key
          ? [row]
          : [...(row.stores > 1 ? [{ ...row, stores: row.stores - 1 }] : []), ...share],
      );
    }
  }
  const orders = await queryAll(
    ctx.assets,
    reorderSlot,
    input.mode === 'reorder' ? { field: 'storeId', op: 'eq', value: input.storeId } : null,
  );
  const byState: Record<string, number> = {};
  for (const record of orders) byState[record.data.state] = (byState[record.data.state] ?? 0) + 1;
  const ruleset = await ctx.assets.get(segmentRulesetSlot, input.rulesetId);
  if (!ruleset) {
    needs.push({
      kind: 'asset',
      slot: 'segment-ruleset',
      filter: null,
      reason: 'Ruleset became unavailable',
      blocking: true,
    });
    return stop();
  }
  const body = SupplyProgramBody.parse({
    ruleset: assetRef(ruleset),
    segmentation,
    matches,
    campaigns,
    reorders: { byState, attributed: orders.filter((record) => record.data.attribution).length },
    replenishShare,
  });
  const hash = await versionHash(body);
  const artifact = SupplyProgram.parse({
    kind: 'SupplyProgram',
    artifactVersion: '0.1.0',
    id: input.programId ?? `supply-${hash.slice(0, 32)}`,
    hash,
    producedBy: { step: 'replenishment/run', pkg: '@osw/replenishment', pkgVersion: '0.1.0' },
    storeId: input.mode === 'reorder' ? input.storeId : (input.opening?.storeId ?? null),
    inputs: [input.opening, input.bom].flatMap((value) =>
      value ? [{ kind: value.kind, id: value.id, hash: value.hash }] : [],
    ),
    sources: observed.sources(),
    createdAt: ctx.now,
    ...(observed.synthetic() &&
    (!input.opening || input.opening.example) &&
    (!input.bom || input.bom.example)
      ? { example: true }
      : {}),
    body,
  });
  return { steps: outputs, artifact, needs };
}
export const workflow: WorkflowModule = {
  key: 'replenishment',
  version: '0.1.0',
  steps,
  slots,
  run,
};
