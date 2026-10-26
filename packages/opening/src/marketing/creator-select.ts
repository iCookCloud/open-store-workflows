import {
  type AssetRecordOf,
  type Filter,
  type Need,
  type ParamScope,
  PartySlot,
  type StepCtx,
  addDays,
  assetRef,
  diffDays,
  jurisdictionPrefixes,
  type z,
} from '@osw/core';
import { inputNeed } from '../helpers.js';
import type { MarketingPlanContent } from '../templates/marketing-plan.js';
import { numeric, queryPages } from './helpers.js';
import type { Candidate, CreatorFact, LedgerEntry } from './models.js';

type Selection = NonNullable<MarketingPlanContent['creatorSelection']>;
type PartyRecord = AssetRecordOf<z.infer<typeof PartySlot.schema>>;
export function evaluateCreator(
  record: PartyRecord,
  fact: CreatorFact | undefined,
  selection: Selection,
  today: string,
  thresholds: {
    activeWithinDays: number;
    maxPostGapDays: number;
    staleDays: number;
    minEngagement: number;
  },
  ledger: LedgerEntry[],
  needs: Need[],
): Candidate {
  const profile = record.data.profiles?.creator;
  const base = {
    ref: assetRef(record),
    eligible: false,
    selected: false,
    needsReview:
      !profile ||
      profile.verifiedOn > today ||
      diffDays(today, profile.verifiedOn) > thresholds.staleDays,
    mixRole: fact?.mixRole,
    proven: ledger.some(
      (row) =>
        row.creatorRef?.id === record.id &&
        ['published', 'settled'].includes(row.status) &&
        row.visits > 0,
    ),
  };
  if (!profile) return { ...base, reason: 'missingProfile' };
  // 四道人工/数据闸按固定顺序解释淘汰原因。
  if (!fact?.locality) {
    needs.push({
      kind: 'action',
      action: 'verifyCreatorLocality',
      ref: record.id,
      reason: 'A named reviewer must verify the creator serves this local audience',
      blocking: false,
    });
    return { ...base, reason: 'locality' };
  }
  if (!fact.locality.local) return { ...base, reason: 'locality' };
  const dates = [...new Set(fact.recentPostDates ?? [])].sort();
  const minimumPostsForGap = 2;
  const activityKnown =
    dates.length >= minimumPostsForGap &&
    dates.at(-1) === profile.lastPostOn &&
    dates.every((date) => date <= today);
  if (!activityKnown) {
    needs.push(
      inputNeed(
        `creatorFacts.${record.id}.recentPostDates`,
        'At least two recent post dates matching the latest profile post are required to verify posting gaps',
        false,
      ),
    );
    return { ...base, reason: 'activity' };
  }
  if (
    diffDays(today, profile.lastPostOn) > thresholds.activeWithinDays ||
    dates.some(
      (date, index) => index > 0 && diffDays(date, dates[index - 1]) > thresholds.maxPostGapDays,
    )
  )
    return { ...base, reason: 'activity' };
  if (profile.engagementPct < thresholds.minEngagement) return { ...base, reason: 'engagement' };
  if (
    !profile.formats.some((format) => selection.formats.includes(format)) ||
    !fact.audienceLanguages?.some((language) => selection.audienceLanguages.includes(language))
  ) {
    if (!fact.audienceLanguages)
      needs.push(
        inputNeed(
          `creatorFacts.${record.id}.audienceLanguages`,
          'Audience language evidence is required',
          false,
        ),
      );
    return { ...base, reason: 'formatOrLanguage' };
  }
  if (base.needsReview)
    needs.push({
      kind: 'action',
      action: 'verifyCreatorMetrics',
      ref: record.id,
      reason: 'Creator metrics are older than the supplied review interval',
      blocking: false,
    });
  return { ...base, eligible: true, reason: 'mix' };
}
export async function selectCreators(
  selection: Selection,
  facts: CreatorFact[],
  ledger: LedgerEntry[],
  today: string,
  ctx: StepCtx,
  scope: ParamScope & { jurisdiction: string },
) {
  const needs: Need[] = [];
  const activeWithinDays = numeric(ctx, 'marketing.creator.activeWithinDays', scope, needs);
  const maxPostGapDays = numeric(ctx, 'marketing.creator.maxPostGapDays', scope, needs);
  const staleDays = numeric(ctx, 'marketing.creator.staleDays', scope, needs);
  const thresholds = new Map(
    selection.tiers.map((tier) => [
      tier,
      numeric(ctx, 'marketing.creator.minEngagement', { ...scope, qualifier: tier }, needs, 100),
    ]),
  );
  const mix = new Map(
    selection.mixRoles.map((role) => [
      role,
      {
        min: numeric(ctx, 'marketing.creator.mixMin', { ...scope, qualifier: role }, needs),
        max: numeric(ctx, 'marketing.creator.mixMax', { ...scope, qualifier: role }, needs),
      },
    ]),
  );
  for (const [role, range] of mix)
    if (
      range.min !== null &&
      range.max !== null &&
      (!Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max)
    )
      needs.push(
        inputNeed(
          `params.marketing.creator.mix.${role}`,
          'Creator mix requires integer min <= max',
        ),
      );
  if (needs.some((need) => need.blocking)) return { candidates: [], needs, sources: [] };
  const age = activeWithinDays!;
  if (!Number.isInteger(age))
    return {
      candidates: [],
      needs: [
        inputNeed('params.marketing.creator.activeWithinDays', 'Posting age must be integer days'),
      ],
      sources: [],
    };
  const filter: Filter = {
    all: [
      { field: 'roles', op: 'hasAny', value: ['creator'] },
      { field: 'status', op: 'eq', value: 'active' },
      { field: 'jurisdictions', op: 'hasAny', value: jurisdictionPrefixes(scope.jurisdiction) },
      { field: 'profiles.creator.lastPostOn', op: 'gte', value: addDays(today, -age) },
      {
        any: selection.tiers.map(
          (tier): Filter => ({
            all: [
              { field: 'profiles.creator.tier', op: 'eq', value: tier },
              { field: 'profiles.creator.engagementPct', op: 'gte', value: thresholds.get(tier)! },
            ],
          }),
        ),
      },
    ],
  };
  const records = await queryPages(ctx.assets, PartySlot, filter);
  const byId = new Map(facts.map((fact) => [fact.partyId, fact]));
  const candidates = records.map((record) =>
    evaluateCreator(
      record,
      byId.get(record.id),
      selection,
      today,
      {
        activeWithinDays: age,
        maxPostGapDays: maxPostGapDays!,
        staleDays: staleDays!,
        minEngagement: thresholds.get(record.data.profiles?.creator?.tier ?? '')!,
      },
      ledger,
      needs,
    ),
  );
  // 已验证的合作先排；同档按稳定 ID 排序，保证运行结果可重复。
  candidates.sort(
    (a, b) =>
      Number(b.proven) - Number(a.proven) ||
      (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0),
  );
  for (const [role, range] of mix) {
    const eligible = candidates.filter(
      (candidate) => candidate.eligible && candidate.mixRole === role,
    );
    const selected = eligible.slice(0, range.max!);
    for (const candidate of selected) {
      candidate.selected = true;
      candidate.reason = 'selected';
    }
    if (selected.length < range.min!)
      needs.push({
        kind: 'asset',
        slot: 'party',
        filter,
        reason: `Creator mix ${role} has ${selected.length} eligible candidates, requires ${range.min}`,
        blocking: false,
      });
  }
  return { candidates, needs, sources: records.map((record) => assetRef(record)) };
}
