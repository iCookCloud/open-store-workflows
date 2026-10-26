import {
  ArtifactEnvelope,
  AssetRef,
  type AssetRef as AssetReference,
  type Filter,
  Hash,
  IsoDate,
  Money,
  type Need,
  OpeningRecordBody,
  type ParamDecl,
  type ParamScope,
  type StepCtx,
  StoreSpecBody,
  TemplateSlot,
  addDays,
  assetRef,
  roundMoney,
  stepResult,
  todayIn,
  versionHash,
  z,
} from '@osw/core';
import {
  blocked,
  defineStep,
  inputNeed,
  jurisdictionFit,
  latestApproval,
  queryAll,
  selectTemplate,
  uniqueRefs,
  validArtifact,
} from '../helpers.js';
import { contentCaseSlot } from '../slots/content-case.js';
import { contentPlaybookSlot } from '../slots/content-playbook.js';
import { AssetPlanContent } from '../templates/asset-plan.js';
import { MarketingPlanContent } from '../templates/marketing-plan.js';
import { deriveAssetGap } from './asset-gap.js';
import { contentCalendar } from './content-calendar.js';
import { selectCreators } from './creator-select.js';
import { numeric, usedParamRefs, withMarketingParams } from './helpers.js';
import { marketingLedger } from './ledger.js';
import { AssetProgress, Candidate, CreatorFact, LedgerEntry, Marketing } from './models.js';

export const MARKETING_PARAM_KEYS = [
  'marketing.creator.activeWithinDays',
  'marketing.creator.maxPostGapDays',
  'marketing.creator.staleDays',
  'marketing.creator.minEngagement',
  'marketing.creator.mixMin',
  'marketing.creator.mixMax',
  'marketing.budget.revenueRate',
  'marketing.budget.reserveRate',
  'marketing.budget.split',
  'marketing.ads.stageWeight',
] as const;
export const marketingParams: ParamDecl[] = MARKETING_PARAM_KEYS.map((key) => ({
  key,
  required: true,
  description: 'Operator-supplied opening marketing policy',
}));
export const PlanMarketingInput = z.object({
  storeSpec: ArtifactEnvelope('StoreSpec', StoreSpecBody),
  openingDate: IsoDate,
  templateId: z.string().optional(),
  assetTemplateId: z.string().optional(),
  playbookIds: z.array(z.string()).optional(),
  itemStatuses: z
    .array(z.object({ key: z.string(), status: Marketing.shape.items.element.shape.status }))
    .default([]),
  ledger: z.array(LedgerEntry).default([]),
  previousLedger: z.array(LedgerEntry).default([]),
  creatorFacts: z.array(CreatorFact).default([]),
  assetProgress: z.array(AssetProgress).default([]),
});
export const Budget = z.object({
  category: z.string(),
  approved: z.boolean(),
  subjectHash: Hash,
  total: Money.nullable(),
  reserve: Money.nullable(),
  channels: z.array(
    z.object({
      channel: z.string(),
      total: Money,
      stages: z.array(z.object({ stage: z.string(), amount: Money })),
    }),
  ),
});
export const PlanMarketingOutput = z.object({
  marketing: OpeningRecordBody.shape.marketing,
  budgets: z.array(Budget),
  candidates: z.array(Candidate),
  missingEvidence: z.array(z.string()),
  cac: Money.nullable(),
  calendar: z.array(
    z.object({
      key: z.string(),
      goal: z.string(),
      date: IsoDate,
      beats: z.array(z.string()),
      source: AssetRef,
    }),
  ),
  contentCases: z.array(z.object({ ref: AssetRef, goal: z.string(), url: z.url() })),
  coreIncomplete: z.array(z.string()),
  sources: z.array(AssetRef),
  approvalSubjects: z.array(z.object({ subject: z.string(), subjectHash: Hash })),
  rules: z.array(z.enum(['noBoughtReviews', 'noSolicitedReviews', 'paidDisclosureRequired'])),
});

async function templateRef(
  ctx: StepCtx,
  id: string | undefined,
  kind: string,
  needs: Need[],
): Promise<AssetReference | undefined> {
  if (!id) return undefined;
  const record = await ctx.assets.get(TemplateSlot, id);
  if (!record)
    needs.push({
      kind: 'asset',
      slot: 'template',
      filter: { field: 'id', op: 'eq', value: id },
      reason: `Missing ${kind} template`,
      blocking: true,
    });
  return record ? assetRef(record) : undefined;
}
function closeToOne(values: number[]) {
  return (
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <=
    Number.EPSILON * Math.max(values.length, 1)
  );
}
async function deriveBudgets(
  content: MarketingPlanContent,
  ref: AssetReference,
  input: z.infer<typeof PlanMarketingInput>,
  ctx: StepCtx,
  scope: ParamScope,
  needs: Need[],
) {
  const rate = numeric(ctx, 'marketing.budget.revenueRate', scope, needs, 1);
  const reserveRate = numeric(ctx, 'marketing.budget.reserveRate', scope, needs, 1);
  const breakeven = input.storeSpec.body.economics.breakeven;
  if (breakeven.status !== 'ok')
    needs.push(
      inputNeed(
        'storeSpec.body.economics.breakeven',
        'A usable breakeven revenue is required to plan marketing budgets',
      ),
    );
  const currency = input.storeSpec.body.economics.spend.currency;
  const base =
    breakeven.status === 'ok' && rate !== null
      ? roundMoney({ amount: rate * breakeven.revenue.amount, currency })
      : null;
  const channels = [...new Set(content.items.map((item) => item.channel))];
  const splits = new Map(
    channels.map((channel) => [
      channel,
      numeric(ctx, 'marketing.budget.split', { ...scope, qualifier: channel }, needs, 1),
    ]),
  );
  if (
    channels.length &&
    [...splits.values()].every((v) => v !== null) &&
    !closeToOne([...splits.values()] as number[])
  )
    needs.push(inputNeed('params.marketing.budget.split', 'Channel budget shares must sum to one'));
  const channelCategories = new Map<string, string>();
  for (const item of content.items) {
    const owner = channelCategories.get(item.channel);
    if (owner && owner !== item.category)
      needs.push(
        inputNeed('template.items', 'Each budget channel must belong to exactly one category'),
      );
    channelCategories.set(item.channel, item.category);
  }
  const proposals = new Map<
    string,
    {
      channel: string;
      total: z.infer<typeof Money>;
      reserve: z.infer<typeof Money>;
      stages: { stage: string; amount: z.infer<typeof Money> }[];
    }[]
  >();
  for (const channel of channels) {
    const stages = [
      ...new Set(
        content.items.filter((item) => item.channel === channel).map((item) => item.stage),
      ),
    ];
    const weights = new Map(
      stages.map((stage) => [
        stage,
        numeric(ctx, 'marketing.ads.stageWeight', { ...scope, qualifier: stage }, needs, 1),
      ]),
    );
    if (
      [...weights.values()].every((v) => v !== null) &&
      !closeToOne([...weights.values()] as number[])
    )
      needs.push(
        inputNeed(
          `params.marketing.ads.stageWeight.${channel}`,
          'Stage budget weights must sum to one per channel',
        ),
      );
    const share = splits.get(channel);
    if (
      !base ||
      share === null ||
      share === undefined ||
      reserveRate === null ||
      [...weights.values()].some((v) => v === null)
    )
      continue;
    const total = roundMoney({ amount: base.amount * share, currency });
    const reserve = roundMoney({ amount: total.amount * reserveRate, currency });
    const plannedStages = stages.map((stage) => ({
      stage,
      amount: roundMoney({
        amount: (total.amount - reserve.amount) * weights.get(stage)!,
        currency,
      }),
    }));
    const last = plannedStages.at(-1);
    // 行级舍入差额归最后一个阶段，保证预算守恒。
    if (last)
      last.amount = roundMoney({
        amount:
          last.amount.amount +
          total.amount -
          reserve.amount -
          plannedStages.reduce((sum, item) => sum + item.amount.amount, 0),
        currency,
      });
    const category = channelCategories.get(channel)!;
    const rows = proposals.get(category) ?? [];
    rows.push({ channel, total, reserve, stages: plannedStages });
    proposals.set(category, rows);
  }
  const budgets: z.infer<typeof Budget>[] = [];
  for (const category of [...new Set(content.items.map((item) => item.category))].sort()) {
    const proposed = proposals.get(category) ?? [];
    const subjectHash = await versionHash({
      category,
      template: ref,
      openingDate: input.openingDate,
      items: content.items.filter((item) => item.category === category),
      proposed,
    });
    const approval = latestApproval(ctx, 'opening/planMarketing', subjectHash, category);
    const approved = approval?.decision === 'approved';
    if (!approval || !['approved', 'rejected'].includes(approval.decision))
      needs.push({
        kind: 'approval',
        step: 'opening/planMarketing',
        subject: category,
        subjectHash,
        question: `Approve opening marketing category ${category}?`,
        blocking: false,
      });
    budgets.push({
      category,
      subjectHash,
      approved,
      total: approved
        ? roundMoney({ amount: proposed.reduce((sum, row) => sum + row.total.amount, 0), currency })
        : null,
      reserve: approved
        ? roundMoney({
            amount: proposed.reduce((sum, row) => sum + row.reserve.amount, 0),
            currency,
          })
        : null,
      channels: approved
        ? proposed.map(({ channel, total, stages }) => ({ channel, total, stages }))
        : [],
    });
  }
  return budgets;
}
export const planMarketing = defineStep({
  id: 'opening/planMarketing',
  input: PlanMarketingInput,
  output: PlanMarketingOutput,
  reads: ['template', 'party', 'content-case', 'content-playbook', 'params'],
  params: marketingParams,
  approval: {
    question: 'Approve the marketing category?',
    decision: z.enum(['approved', 'rejected']),
  },
  async run(input, baseCtx) {
    const needs: Need[] = await validArtifact(input.storeSpec, 'storeSpec');
    for (const [name, rows] of [
      ['itemStatuses', input.itemStatuses],
      ['ledger', input.ledger],
      ['previousLedger', input.previousLedger],
      ['creatorFacts', input.creatorFacts],
      ['assetProgress', input.assetProgress],
    ] as const) {
      const keys = rows.map((row) => ('key' in row ? row.key : 'id' in row ? row.id : row.partyId));
      if (new Set(keys).size !== keys.length)
        needs.push(inputNeed(name, 'Duplicate keys are not allowed'));
    }
    const scope = {
      jurisdiction: input.storeSpec.body.jurisdiction,
      track: input.storeSpec.body.concept.track,
    };
    const planRef = await templateRef(baseCtx, input.templateId, 'marketing-plan', needs);
    const assetRefInput = await templateRef(baseCtx, input.assetTemplateId, 'asset-plan', needs);
    if (needs.some((need) => need.blocking))
      return blocked<z.infer<typeof PlanMarketingOutput>>(needs);
    const plan = await selectTemplate(
      baseCtx,
      'marketing-plan',
      scope.track,
      scope.jurisdiction,
      MarketingPlanContent,
      planRef,
    );
    const assets = await selectTemplate(
      baseCtx,
      'asset-plan',
      scope.track,
      scope.jurisdiction,
      AssetPlanContent,
      assetRefInput,
    );
    needs.push(...plan.needs, ...assets.needs);
    if (
      !plan.content ||
      !plan.record ||
      !assets.content ||
      !assets.record ||
      needs.some((need) => need.blocking)
    )
      return blocked<z.infer<typeof PlanMarketingOutput>>(needs);
    const content = plan.content;
    const allowedItems = new Set(content.items.map((item) => item.key));
    for (const status of input.itemStatuses)
      if (!allowedItems.has(status.key))
        needs.push(inputNeed('itemStatuses', `Unknown marketing item ${status.key}`));
    for (const progress of input.assetProgress)
      if (!assets.content.items.some((item) => item.key === progress.key))
        needs.push(inputNeed('assetProgress', `Unknown asset item ${progress.key}`));
    const dynamic = [
      ...new Set(content.items.map((item) => `marketing.budget.split.${item.channel}`)),
      ...new Set(content.items.map((item) => `marketing.ads.stageWeight.${item.stage}`)),
      ...(content.creatorSelection?.tiers.map(
        (tier) => `marketing.creator.minEngagement.${tier}`,
      ) ?? []),
      ...(content.creatorSelection?.mixRoles.flatMap((role) => [
        `marketing.creator.mixMin.${role}`,
        `marketing.creator.mixMax.${role}`,
      ]) ?? []),
      ...input.ledger.map(
        (row) =>
          `fx.${(row.barterCost ?? row.spend).currency}.${input.storeSpec.body.economics.spend.currency}`,
      ),
    ];
    const ctx = await withMarketingParams(baseCtx, [...MARKETING_PARAM_KEYS, ...dynamic], scope);
    const statuses = new Map(input.itemStatuses.map((item) => [item.key, item.status]));
    const items = content.items.map((item) =>
      Marketing.shape.items.element.parse({
        ...item,
        dueDate: addDays(input.openingDate, item.dayOffset),
        status: statuses.get(item.key) ?? 'todo',
      }),
    );
    const budgets = await deriveBudgets(content, assetRef(plan.record), input, ctx, scope, needs);
    let today: string;
    try {
      today = todayIn(input.storeSpec.body.timezone, ctx.now);
    } catch {
      needs.push(inputNeed('storeSpec.body.timezone', 'Expected a valid IANA timezone'));
      return blocked<z.infer<typeof PlanMarketingOutput>>(needs);
    }
    const creators = content.creatorSelection
      ? await selectCreators(
          content.creatorSelection,
          input.creatorFacts,
          input.ledger,
          today,
          ctx,
          scope,
        )
      : { candidates: [], needs: [], sources: [] };
    needs.push(...creators.needs);
    const applicableDisclosure = content.disclosureRules.filter(
      (rule) => rule.required && jurisdictionFit(scope.jurisdiction, rule.jurisdiction) !== 'no',
    );
    for (const rule of applicableDisclosure)
      if (jurisdictionFit(scope.jurisdiction, rule.jurisdiction) === 'unsure')
        needs.push({
          kind: 'action',
          action: 'verifyDisclosureJurisdiction',
          ref: rule.jurisdiction,
          reason:
            'Confirm whether the more specific jurisdiction disclosure rule applies; disclosure is required pending confirmation',
          blocking: false,
        });
    const ledger = marketingLedger(
      input.ledger,
      input.previousLedger,
      input.storeSpec.body.economics.spend.currency,
      ctx,
      scope,
      applicableDisclosure.length > 0,
    );
    needs.push(...ledger.needs);
    const applicability: Filter = {
      any: [
        { field: 'coverage.tracks', op: 'hasAny', value: [scope.track] },
        { field: 'coverage.tier', op: 'eq', value: 'general' },
      ],
    };
    if (input.playbookIds && new Set(input.playbookIds).size !== input.playbookIds.length)
      needs.push(inputNeed('playbookIds', 'Duplicate playbook IDs are not allowed'));
    const playbooks = input.playbookIds
      ? await Promise.all(input.playbookIds.map((id) => ctx.assets.get(contentPlaybookSlot, id)))
      : await queryAll(ctx.assets, contentPlaybookSlot, applicability);
    if (playbooks.some((record) => !record))
      needs.push({
        kind: 'asset',
        slot: 'content-playbook',
        filter: null,
        reason: 'A requested playbook is missing',
        blocking: true,
      });
    const knownPlaybooks = playbooks.filter((record) => record !== null);
    for (const record of knownPlaybooks) contentPlaybookSlot.validate?.(record.data);
    const cases = await queryAll(ctx.assets, contentCaseSlot, applicability);
    const usedKeys = [
      'marketing.budget.revenueRate',
      'marketing.budget.reserveRate',
      ...(content.creatorSelection
        ? [
            'marketing.creator.activeWithinDays',
            'marketing.creator.maxPostGapDays',
            'marketing.creator.staleDays',
          ]
        : []),
    ];
    const uses = usedKeys.map((key) => ({ key, scope: scope as ParamScope }));
    for (const channel of new Set(content.items.map((item) => item.channel)))
      uses.push({ key: 'marketing.budget.split', scope: { ...scope, qualifier: channel } });
    for (const stage of new Set(content.items.map((item) => item.stage)))
      uses.push({ key: 'marketing.ads.stageWeight', scope: { ...scope, qualifier: stage } });
    for (const tier of content.creatorSelection?.tiers ?? [])
      uses.push({ key: 'marketing.creator.minEngagement', scope: { ...scope, qualifier: tier } });
    for (const role of content.creatorSelection?.mixRoles ?? [])
      for (const key of ['marketing.creator.mixMin', 'marketing.creator.mixMax'] as const)
        uses.push({ key, scope: { ...scope, qualifier: role } });
    const fxRefs = input.ledger.flatMap(
      (row) =>
        ctx.params.refs?.(
          `fx.${(row.barterCost ?? row.spend).currency}.${input.storeSpec.body.economics.spend.currency}`,
          scope,
        ) ?? [],
    );
    const output: z.infer<typeof PlanMarketingOutput> = {
      marketing: {
        template: assetRef(plan.record),
        items,
        ledger: ledger.rows,
        assetGap: deriveAssetGap(assets.content, input.assetProgress),
      },
      budgets,
      contentCases: cases.map((record) => ({
        ref: assetRef(record),
        goal: record.data.goal,
        url: record.data.url,
      })),
      candidates: creators.candidates,
      missingEvidence: ledger.missingEvidence,
      cac: ledger.cac,
      calendar: contentCalendar(input.openingDate, knownPlaybooks),
      coreIncomplete: items
        .filter((item) => item.core && !['done', 'skipped'].includes(item.status))
        .map((item) => item.key),
      sources: uniqueRefs([
        assetRef(plan.record),
        assetRef(assets.record),
        ...creators.sources,
        ...knownPlaybooks.map((record) => assetRef(record)),
        ...cases.map((record) => assetRef(record)),
        ...input.ledger.flatMap((row) => (row.creatorRef ? [row.creatorRef] : [])),
        ...usedParamRefs(ctx, uses),
        ...fxRefs,
      ]),
      approvalSubjects: budgets.map(({ category, subjectHash }) => ({
        subject: category,
        subjectHash,
      })),
      rules: ['noBoughtReviews', 'noSolicitedReviews', 'paidDisclosureRequired'],
    };
    return stepResult(output, needs, ledger.verifications);
  },
});
