import { type Need, type StepCtx, type StepResult, z } from '@osw/core';
import { SiteDecision } from './contracts.js';
import { inputNeed, withExchangeRates } from './rules/common.js';
import { assessRent, moneyIn } from './rules/rent.js';
import { CounselShortlist, DocDraft, LeaseReviewInput } from './steps/legal.js';
import { Screening, ScreeningInput } from './steps/screen.js';
import { AssessmentInput, Shortlist, assessSite } from './steps/selection.js';
import { Survey, SurveyInput } from './steps/survey.js';
import { workflowSteps } from './workflow-steps.js';

export async function run(raw: unknown, ctx: StepCtx) {
  const plan = z.record(z.string(), z.unknown()).parse(raw);
  const steps: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  const inputs: Record<string, unknown> = {};
  let artifact: unknown = null;
  for (const step of workflowSteps) {
    const name = step.id.split('/')[1]!;
    if (plan[name] === undefined) {
      const need = inputNeed(name, `Provide input for ${step.id}`);
      needs.push(need);
      steps[name] = { output: null, verifications: [], needs: [need] };
      break;
    }
    const value = z.record(z.string(), z.unknown()).safeParse(plan[name]);
    let supplied: unknown = plan[name];
    // 只允许显式的人类输入；上游引用由刚完成的步骤覆盖，避免混入旧店或旧版本。
    if (value.success) {
      supplied = { ...value.data };
      const input = supplied as Record<string, unknown>;
      if (name === 'scanSurroundings') {
        const screened = Screening.parse(steps.screenListings!.output);
        const initial = ScreeningInput.parse(inputs.screenListings);
        input.candidates = [...screened.passed, ...screened.pending].map((r) => r.listing);
        input.track = initial.spec.concept.track;
        input.cuisine = initial.spec.concept.cuisine;
      }
      if (name === 'shortlist') {
        const screened = Screening.parse(steps.screenListings!.output);
        const allowed = [...screened.passed, ...screened.pending];
        if (Array.isArray(input.entries))
          for (const entry of input.entries) {
            if (entry && typeof entry === 'object' && 'listing' in entry) {
              const ref = (entry as { listing: { id?: string; versionHash?: string } }).listing;
              if (
                !allowed.some(
                  (r) => r.listing.id === ref?.id && r.listing.versionHash === ref?.versionHash,
                )
              ) {
                needs.push(
                  inputNeed(
                    'shortlist.entries',
                    'Shortlist must use current eligible screening candidates',
                  ),
                );
              }
            }
          }
      }
      if (name === 'assessSite') {
        const initial = ScreeningInput.parse(inputs.screenListings);
        input.spec = initial.spec;
        input.center = initial.center;
        input.additionalRent = initial.additionalRent;
        const selected = Shortlist.parse(steps.shortlist!.output);
        const listing = input.listing as { id?: string; versionHash?: string } | undefined;
        if (
          !selected.some(
            (s) => s.listing.id === listing?.id && s.listing.versionHash === listing?.versionHash,
          )
        )
          needs.push(inputNeed('assessSite.listing', 'Assess a current shortlisted listing'));
      }
      if (name === 'surveySite') {
        const assessed = AssessmentInput.parse(inputs.assessSite);
        input.listing = assessed.listing;
        input.requirements = assessed.spec.siteRequirements;
      }
      if (name === 'chooseSite') {
        const surveyed = SurveyInput.parse(inputs.surveySite);
        input.listing = surveyed.listing;
        input.survey = Survey.parse(steps.surveySite!.output);
        const reasons = value.data.rejectionReasons as Record<string, string> | undefined;
        input.shortlist = Shortlist.parse(steps.shortlist!.output).map((s) => ({
          ...s,
          status: s.listing.id === surveyed.listing.id ? 'visited' : 'rejected',
          reason:
            s.listing.id === surveyed.listing.id ? s.reason : (reasons?.[s.listing.id] ?? s.reason),
        }));
      }
      if (name === 'matchCounsel')
        input.jurisdiction = SiteDecision.parse(steps.chooseSite!.output).body.jurisdiction;
      if (name === 'draftLoi') input.site = SiteDecision.parse(steps.chooseSite!.output);
      if (name === 'reviewLease') {
        const loi = DocDraft.parse(steps.draftLoi!.output);
        input.loi = loi.site.body.lease;
        input.jurisdiction = loi.site.body.jurisdiction;
        input.counsel = CounselShortlist.parse(steps.matchCounsel!.output).engaged;
      }
      if (name === 'signLease') {
        const reassessed = await assessSite(
          {
            ...AssessmentInput.parse(inputs.assessSite),
            survey: Survey.parse(steps.surveySite!.output),
          },
          ctx,
        );
        const review = LeaseReviewInput.parse(inputs.reviewLease);
        const lease = review.documents.find((d) => d.kind === 'lease')?.terms;
        if (lease) {
          const initial = ScreeningInput.parse(inputs.screenListings);
          const assessed = AssessmentInput.parse(inputs.assessSite);
          const currency = initial.spec.economics.spend.currency;
          const rates = await withExchangeRates(ctx, [
            [lease.rent.base.currency, currency],
            ...lease.rent.additional.flatMap((r) =>
              r.estimate ? [[r.estimate.currency, currency] as [string, string]] : [],
            ),
          ]);
          const fees = lease.rent.additional.map((r) =>
            r.estimate
              ? moneyIn(
                  {
                    amount: r.estimate.amount / (r.period === 'year' ? 12 : 1),
                    currency: r.estimate.currency,
                  },
                  currency,
                  rates,
                  needs,
                )
              : null,
          );
          const extra = fees.every((f) => f !== null)
            ? { amount: fees.reduce((sum, f) => sum + f!.amount, 0), currency }
            : undefined;
          const finalRent = assessRent(
            {
              ...assessed.listing.data,
              askingRent: lease.rent,
              additionalRent: lease.rent.additional.length ? 'nnn' : 'gross',
            },
            initial.spec,
            rates,
            extra,
          );
          needs.push(...finalRent.needs);
          if (finalRent.checks.some((c) => c.verdict !== 'holds'))
            needs.push(
              inputNeed(
                'signLease.rent',
                'Final lease rent and additional charges must satisfy the approved store budget',
              ),
            );
        }
        const unresolved = reassessed.output?.missing.filter((_, index) => index !== 4).flat() ?? [
          'assessment',
        ];
        if (unresolved.length)
          needs.push(
            inputNeed('signLease.assessment', `Resolve before signing: ${unresolved.join(', ')}`),
          );

        input.site = DocDraft.parse(steps.draftLoi!.output).site;
        input.review = LeaseReviewInput.parse(inputs.reviewLease);
      }
    }
    if (needs.some((n) => n.blocking)) {
      steps[name] = { output: null, verifications: [], needs: needs.filter((n) => n.blocking) };
      break;
    }
    const input = step.input.safeParse(supplied);
    if (!input.success) {
      const invalid = input.error.issues.map((i) =>
        inputNeed(`${name}.${i.path.join('.')}`, i.message),
      );
      needs.push(...invalid);
      steps[name] = { output: null, verifications: [], needs: invalid };
      break;
    }
    inputs[name] = input.data;
    const result = await step.run(input.data, ctx);
    steps[name] = result;
    needs.push(...result.needs);
    if (result.needs.some((n) => n.blocking) || result.output === null) break;
    step.output.parse(result.output);
    if (name === 'chooseSite' || name === 'signLease') artifact = result.output;
    if (name === 'draftLoi') artifact = DocDraft.parse(result.output).site;
  }
  return { steps, artifact: needs.some((n) => n.blocking) ? null : artifact, needs };
}
