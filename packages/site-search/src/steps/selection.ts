import {
  ArtifactEnvelope,
  AssetRecord,
  AssetRef,
  IsoDate,
  Measure,
  type Need,
  type StepCtx,
  type Verification,
  convertUnit,
  jurisdictionPrefixes,
  templateSlot,
  versionHash,
  z,
} from '@osw/core';
import { CheckedSiteDecisionBody as SiteDecisionBody } from '../contracts.js';
import { approvalFor } from '../rules/approval.js';
import { assetRef, inputNeed, numberParam, result } from '../rules/common.js';
import { queryAll } from '../rules/common.js';
import { evidenceProblem } from '../rules/measure.js';
import { Listing } from '../slots/listing.js';
import { CheckSchema, ScreeningInput, candidateChecks } from './screen.js';
import { Survey } from './survey.js';
export const ShortlistEntry = z.object({
  listing: AssetRef,
  status: z.enum(['shortlisted', 'visited', 'rejected', 'chosen']),
  reason: z.string(),
});
export const Shortlist = z.array(ShortlistEntry).superRefine((entries, ctx) => {
  if (new Set(entries.map((e) => e.listing.id)).size !== entries.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate listing' });
  if (entries.filter((e) => e.status === 'chosen').length > 1)
    ctx.addIssue({ code: 'custom', message: 'At most one chosen listing' });
  if (entries.some((e) => e.status === 'rejected' && !e.reason.trim()))
    ctx.addIssue({ code: 'custom', message: 'Rejection requires reason' });
});
export const ShortlistInput = z.object({ entries: Shortlist, previous: Shortlist.optional() });
const transitions: Record<string, readonly string[]> = {
  shortlisted: ['shortlisted', 'visited', 'rejected'],
  visited: ['visited', 'rejected', 'chosen'],
  chosen: ['chosen', 'rejected'],
  rejected: ['rejected'],
};
export async function shortlist(raw: z.infer<typeof ShortlistInput>, ctx: StepCtx) {
  const input = ShortlistInput.parse(raw);
  const needs: Need[] = [];
  const cap = numberParam(ctx, 'site.shortlistMax', needs);
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || input.entries.length > cap))
    needs.push(inputNeed('entries', 'Shortlist exceeds the configured positive integer limit'));
  for (const row of input.entries) {
    const previous = input.previous?.find((p) => p.listing.id === row.listing.id);
    if (
      (!previous && row.status !== 'shortlisted') ||
      (previous && !transitions[previous.status]!.includes(row.status))
    )
      needs.push(inputNeed(`entries.${row.listing.id}`, 'Invalid shortlist transition'));
    if (previous && previous.listing.versionHash !== row.listing.versionHash)
      needs.push(
        inputNeed(
          `entries.${row.listing.id}`,
          'Listing changed: rebuild and approve a fresh shortlist',
        ),
      );
  }
  await approvalFor(ctx, 'site-search/shortlist', 'shortlist', input.entries, 'accept', needs);
  return result(input.entries, needs);
}
export const AssessmentInput = ScreeningInput.extend({
  listing: AssetRecord(Listing),
  survey: Survey.optional(),
  availability: Measure.optional(),
  dueDiligence: z
    .array(z.object({ key: z.string(), complete: z.boolean(), evidence: z.array(z.string()) }))
    .optional(),
});
export const Assessment = z.object({
  sources: z.array(AssetRef),
  checks: z.array(CheckSchema),
  missing: z.array(z.array(z.string())),
  firstBlocked: z.number().int().nullable(),
});
export async function assessSite(raw: z.infer<typeof AssessmentInput>, ctx: StepCtx) {
  const input = AssessmentInput.parse(raw);
  const needs: Need[] = [];
  const row = await candidateChecks(input.listing, input, ctx, needs);
  if (input.survey) {
    for (const condition of input.survey.conditions) {
      for (const check of row.checks.filter((c) => c.key === condition.key)) {
        check.verdict = condition.verdict === 'waived' ? 'pending' : condition.verdict;
        check.reason = 'Compared observed survey with StoreSpec';
      }
    }
  }
  const measuredArea = input.survey?.conditions.find((c) => c.key === 'area')?.measure;
  if (measuredArea && typeof measuredArea.value === 'number' && measuredArea.unit) {
    const area = convertUnit(measuredArea.value, measuredArea.unit, 'm2').value;
    const check = row.checks.find((c) => c.key === 'area')!;
    check.verdict =
      area === null
        ? 'pending'
        : area >= input.spec.area.minM2 && area <= input.spec.area.maxM2
          ? 'holds'
          : 'fails';
  }
  if (!input.spec.concept.nonFood) {
    const use = input.survey?.conditions.find((c) => c.key === 'foodUse')?.measure;
    const check = row.checks.find((c) => c.key === 'foodUse')!;
    check.verdict =
      use && !evidenceProblem(use, ctx, needs, true) && typeof use.value === 'boolean'
        ? use.value
          ? 'holds'
          : 'fails'
        : 'pending';
  }
  const templates = await queryAll(
    ctx,
    templateSlot,
    {
      all: [
        { field: 'kind', op: 'eq', value: 'site-dd-checklist' },
        { field: 'jurisdiction', op: 'in', value: jurisdictionPrefixes(input.spec.jurisdiction) },
      ],
    },
    200,
  );
  const mostSpecific = templates.sort(
    (a, b) => (b.data.jurisdiction?.length ?? 0) - (a.data.jurisdiction?.length ?? 0),
  );
  const matching = mostSpecific[0];
  const ambiguous = matching && mostSpecific[1]?.data.jurisdiction === matching.data.jurisdiction;
  const checklist = z
    .object({ checks: z.array(z.object({ key: z.string().min(1) })).min(1) })
    .safeParse(matching?.data.content);
  const required =
    checklist.success && !ambiguous ? checklist.data.checks.map((c) => c.key) : ['template'];
  if (!checklist.success || ambiguous)
    needs.push({
      kind: 'asset',
      slot: 'template',
      filter: null,
      reason: 'One jurisdiction-matching due-diligence checklist is required',
      blocking: false,
    });
  const verifications: Verification[] = [];
  const availability = input.availability;
  const status = row.checks.find((c) => c.key === 'status')!;
  status.verdict = 'pending';
  status.reason = 'Availability needs independent confirmation';
  if (
    availability &&
    typeof availability.value === 'boolean' &&
    availability.by &&
    !evidenceProblem(availability, ctx, needs, true) &&
    !availability.refs?.some((r) => input.listing.data.refs.includes(r))
  ) {
    status.verdict = availability.value ? 'holds' : 'fails';
    status.reason = 'Availability independently confirmed';
    verifications.push({
      asset: assetRef(input.listing),
      purpose: 'site-search/assessSite',
      dimension: 'status',
      verdict: availability.value === (input.listing.data.status === 'active') ? 'holds' : 'fails',
      reason: 'Independent availability check compared with listing status',
      at: ctx.now,
      by: ctx.actor,
      evidence: availability.refs,
    });
  }
  for (const key of required) {
    const item = input.dueDiligence?.find((d) => d.key === key);
    row.checks.push({
      key: `dd.${key}`,
      hard: true,
      verdict: item?.complete && item.evidence.length ? 'holds' : 'pending',
      reason: 'Independent due-diligence evidence required',
    });
  }
  const groups = [
    ['residents'],
    ['status', 'foodUse'],
    ['area', 'deliveryCondition'],
    ['rent', 'occupancyRatio'],
    input.spec.siteRequirements.map((r) => r.key),
    required.map((k) => `dd.${k}`),
  ];
  const missing = groups.map((keys) =>
    row.checks.filter((c) => keys.includes(c.key) && c.verdict !== 'holds').map((c) => c.key),
  );
  const index = missing.findIndex((g) => g.length > 0);
  return {
    ...result(
      {
        checks: row.checks,
        missing,
        firstBlocked: index === -1 ? null : index,
        sources: [...row.sources, ...(matching ? [assetRef(matching)] : [])],
      },
      needs,
    ),
    verifications,
  };
}
export const ChooseInput = z.object({
  example: z.literal(true).optional(),
  sources: z.array(AssetRef).optional(),
  id: z.string().min(1),
  storeId: z.string().nullable(),
  spec: z.object({ kind: z.literal('StoreSpec'), id: z.string(), hash: z.string() }),
  listing: AssetRecord(Listing),
  shortlist: Shortlist,
  survey: Survey,
  openingTarget: IsoDate,
  unit: z.string(),
  floorLevel: z.number().int(),
});
export async function chooseSite(raw: z.infer<typeof ChooseInput>, ctx: StepCtx) {
  const input = ChooseInput.parse(raw);
  const needs: Need[] = [];
  const entry = input.shortlist.find((s) => s.listing.id === input.listing.id);
  if (
    !entry ||
    entry.status !== 'visited' ||
    entry.listing.versionHash !== input.listing.versionHash
  )
    needs.push(inputNeed('shortlist', 'Select a visited listing with the current asset version'));
  if (!input.listing.data.geo)
    needs.push(inputNeed('listing.geo', 'Selected listing needs coordinates'));
  const conditions = structuredClone(input.survey.conditions);
  for (const condition of conditions.filter((c) => c.required?.hard && c.verdict === 'fails')) {
    const approval = await approvalFor(
      ctx,
      'site-search/chooseSite',
      `condition:${condition.key}`,
      { listing: assetRef(input.listing), condition },
      'waive',
      needs,
    );
    if (approval) condition.verdict = 'waived';
  }
  const entries = input.shortlist.map((s) => ({
    ...s,
    status: s.listing.id === input.listing.id ? ('chosen' as const) : ('rejected' as const),
  }));
  if (entries.some((e) => e.status === 'rejected' && !e.reason.trim()))
    needs.push(inputNeed('shortlist', 'Provide reasons for every alternative rejected'));
  const body = {
    stage: 'chosen' as const,
    listing: assetRef(input.listing),
    address: input.listing.data.address,
    geo: input.listing.data.geo!,
    jurisdiction: input.listing.data.jurisdiction,
    unit: input.unit,
    floorLevel: input.floorLevel,
    conditions,
    unmeasured: input.survey.unmeasured,
    openingTarget: input.openingTarget,
    lease: null,
    shortlist: entries,
  };
  await approvalFor(
    ctx,
    'site-search/chooseSite',
    `listing:${input.listing.id}`,
    body,
    'choose',
    needs,
  );
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const parsed = SiteDecisionBody.safeParse(body);
  if (!parsed.success)
    return result(
      null,
      parsed.error.issues.map((i) => inputNeed(i.path.join('.'), i.message)),
    );
  return result(
    await siteEnvelope(
      parsed.data,
      input.id,
      input.storeId,
      [input.spec],
      [...entries.map((e) => e.listing), ...(input.sources ?? [])],
      ctx,
      'chooseSite',
      input.example,
    ),
    needs,
  );
}
export async function siteEnvelope(
  body: z.infer<typeof SiteDecisionBody>,
  id: string,
  storeId: string | null,
  inputs: { kind: 'StoreSpec'; id: string; hash: string }[],
  sources: z.infer<typeof AssetRef>[],
  ctx: StepCtx,
  step: string,
  example?: true,
) {
  return ArtifactEnvelope('SiteDecision', SiteDecisionBody).parse({
    ...(example ? { example } : {}),
    kind: 'SiteDecision',
    artifactVersion: '0.1.0',
    id,
    storeId,
    hash: await versionHash(body),
    body,
    producedBy: { step: `site-search/${step}`, pkg: '@osw/site-search', pkgVersion: '0.1.0' },
    inputs,
    sources,
    createdAt: ctx.now,
  });
}
