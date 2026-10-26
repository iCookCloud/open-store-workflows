import {
  AssetRecord,
  ConditionCheck,
  ConditionReading,
  type Need,
  Requirement,
  type StepCtx,
  type Verification,
  convertUnit,
  z,
} from '@osw/core';
import { assetRef, inputNeed, numberParam, result } from '../rules/common.js';
import { checkRequirement, evidenceProblem } from '../rules/measure.js';
import { Listing } from '../slots/listing.js';
export const SurveyInput = z.object({
  listing: AssetRecord(Listing),
  requirements: z.array(Requirement),
  readings: z.array(ConditionReading),
});
export const Survey = z.object({
  conditions: z.array(ConditionCheck),
  unmeasured: z.array(Requirement),
});
export async function surveySite(raw: z.infer<typeof SurveyInput>, ctx: StepCtx) {
  const input = SurveyInput.parse(raw);
  const needs: Need[] = [];
  const verifications: Verification[] = [];
  const conditions: z.infer<typeof ConditionCheck>[] = [];
  if (new Set(input.readings.map((r) => r.key)).size !== input.readings.length)
    needs.push(inputNeed('readings', 'Duplicate condition readings are ambiguous'));
  for (const reading of input.readings) {
    const issue = evidenceProblem(reading.measure, ctx, needs, true);
    if (issue || reading.measure.basis !== 'observed' || !reading.measure.by) {
      needs.push(
        inputNeed(
          `readings.${reading.key}`,
          issue || 'Survey requires an observer and observed evidence',
        ),
      );
      continue;
    }
    const requirements = input.requirements.filter((r) => r.key === reading.key);
    for (const required of requirements.length ? requirements : [undefined]) {
      const fit = required ? checkRequirement(required, reading.measure, ctx, needs) : null;
      if (fit?.verdict === 'pending') {
        needs.push(inputNeed(`readings.${reading.key}`, fit.reason));
        continue;
      }
      conditions.push({
        ...reading,
        ...(required ? { required } : {}),
        ...(input.listing.data.claims.find((c) => c.key === reading.key)
          ? { claimed: input.listing.data.claims.find((c) => c.key === reading.key)!.measure }
          : {}),
        verdict: fit?.verdict === 'fails' ? 'fails' : 'holds',
      });
    }
  }
  for (const claim of input.listing.data.claims) {
    const observed = input.readings.find((r) => r.key === claim.key)?.measure;
    const verification: Verification = {
      asset: assetRef(input.listing),
      purpose: 'site-search/surveySite',
      dimension: claim.key,
      verdict: 'pending',
      reason: 'No independent valid measurement',
      at: ctx.now,
      by: ctx.actor,
    };
    if (
      observed?.by &&
      observed.basis === 'observed' &&
      !evidenceProblem(observed, ctx, needs, true) &&
      !observed.refs?.some((r) => input.listing.data.refs.includes(r))
    ) {
      let actual = observed.value;
      if (typeof actual === 'number' && claim.measure.unit && observed.unit) {
        const converted = convertUnit(actual, observed.unit, claim.measure.unit);
        if (converted.value === null) {
          verifications.push(verification);
          continue;
        }
        actual = converted.value;
      } else if (claim.measure.unit !== observed.unit) {
        verifications.push(verification);
        continue;
      }
      const expected = claim.measure.value;
      const tolerance =
        typeof actual === 'number' && typeof expected === 'number'
          ? numberParam(ctx, 'site.claimTolerance', needs, { qualifier: claim.key }, false)
          : 0;
      const delta =
        typeof actual === 'number' && typeof expected === 'number' ? actual - expected : undefined;
      verification.verdict =
        tolerance === undefined
          ? 'pending'
          : delta === undefined
            ? actual === expected
              ? 'holds'
              : 'fails'
            : Math.abs(delta) <= tolerance
              ? 'holds'
              : 'fails';
      verification.reason =
        tolerance === undefined
          ? 'Claim tolerance is missing'
          : 'Independent survey compared with advertised claim';
      verification.measured = {
        field: `claims[].${claim.key}`,
        expected: typeof expected === 'boolean' ? String(expected) : expected,
        actual: typeof actual === 'boolean' ? String(actual) : actual,
        ...(claim.measure.unit ? { unit: claim.measure.unit } : {}),
        ...(delta !== undefined ? { delta } : {}),
      };
      verification.evidence = observed.refs;
    }
    verifications.push(verification);
  }
  const unmeasured = input.requirements.filter(
    (r) =>
      !conditions.some(
        (c) => c.key === r.key && c.required?.op === r.op && c.required?.value === r.value,
      ),
  );
  return { ...result({ conditions, unmeasured }, needs), verifications };
}
