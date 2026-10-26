import { type Measure, type Need, type Requirement, type StepCtx, meets } from '@osw/core';
import { type Check, numberParam } from './common.js';

export function evidenceProblem(
  measure: Measure | undefined,
  ctx: StepCtx,
  needs: Need[],
  hard: boolean,
): string | null {
  if (!measure) return 'No reading';
  if (!measure.refs?.length) return 'Reading has no evidence';
  if (
    !measure.at ||
    !Number.isFinite(Date.parse(measure.at)) ||
    Date.parse(measure.at) > Date.parse(ctx.now)
  )
    return 'Reading date is missing or in the future';
  if (measure.expiresAt && measure.expiresAt < ctx.now.slice(0, 10)) return 'Reading expired';
  if (!measure.basis || measure.basis === 'estimate' || (hard && measure.basis === 'claimed'))
    return 'Independent observed evidence is required';
  const maxAge = numberParam(
    ctx,
    'site.evidenceMaxAgeDays',
    needs,
    { qualifier: measure.basis },
    false,
  );
  if (maxAge === undefined) return 'Evidence freshness policy is missing';
  if ((Date.parse(ctx.now) - Date.parse(measure.at)) / 86400000 > maxAge)
    return 'Reading is too old';
  return null;
}
export function checkRequirement(
  requirement: Requirement,
  measure: Measure | undefined,
  ctx: StepCtx,
  needs: Need[],
): Check {
  const issue = evidenceProblem(measure, ctx, needs, requirement.hard);
  if (issue || !measure)
    return {
      key: requirement.key,
      verdict: 'pending',
      hard: requirement.hard,
      reason: issue || 'No reading',
    };
  const comparison = meets(requirement, { key: requirement.key, measure });
  return {
    key: requirement.key,
    verdict: comparison.value === null ? 'pending' : comparison.value ? 'holds' : 'fails',
    hard: requirement.hard,
    reason:
      comparison.value === true
        ? 'Requirement met'
        : comparison.value === false
          ? 'Requirement not met'
          : 'Incompatible or missing units',
  };
}
