import {
  ArtifactEnvelope,
  type Need,
  type StepDef,
  StoreSpecBody,
  versionHash,
  z,
} from '@osw/core';
import { assetRef, blocked, result, uniqueRefs } from '../helpers.js';
import { SiteRequirements } from '../models.js';

export const StoreSpec = ArtifactEnvelope('StoreSpec', StoreSpecBody);
export type StoreSpec = z.infer<typeof StoreSpec>;
export function buildStoreSpecBody(input: z.infer<typeof SiteRequirements>) {
  const { calibration } = input;
  const { selection, economics } = calibration.estimate;
  const { brief, template } = selection.concept;
  const {
    capacity,
    staffing,
    fixedMonthly: _fixedMonthly,
    proportionalRate: _proportionalRate,
    contributionRate: _contributionRate,
    ...amounts
  } = economics;
  return StoreSpecBody.parse({
    ...(brief.supersedes ? { supersedes: brief.supersedes } : {}),
    concept: {
      storeType: template.data.storeType,
      track: template.data.track,
      ...(brief.cuisine
        ? { cuisine: brief.cuisine }
        : template.data.cuisines.length === 1
          ? { cuisine: template.data.cuisines[0] }
          : {}),
      nonFood: template.data.nonFood,
      revenueModel: template.data.revenueModel,
    },
    jurisdiction: brief.jurisdiction,
    ...(brief.city ? { city: brief.city } : {}),
    timezone: brief.timezone,
    menu: selection.menu,
    area: input.area,
    capacity,
    staffing,
    economics: {
      ...amounts,
      template: assetRef(template),
      investment: calibration.investment,
      budgetRange: calibration.budgetRange,
      rentCeiling: input.rentCeiling,
    },
    siteRequirements: input.siteRequirements,
    downstream: selection.downstream,
  });
}
export const assembleSpec: StepDef<typeof SiteRequirements, typeof StoreSpec> = {
  id: 'store-concept/assembleSpec',
  input: SiteRequirements,
  output: StoreSpec,
  reads: [],
  params: [],
  approval: {
    question: 'Release this store concept for downstream workflows?',
    decision: z.enum(['release']),
  },
  async run(raw, ctx) {
    const input = SiteRequirements.parse(raw);
    const { selection } = input.calibration.estimate;
    const { brief, template, profile } = selection.concept;
    const body = buildStoreSpecBody(input);
    const hash = await versionHash(body);
    const approval = ctx.approvals.find(
      (approval) =>
        approval.step === 'store-concept/assembleSpec' &&
        approval.subjectHash === hash &&
        approval.decision === 'release' &&
        Date.parse(approval.at) <= Date.parse(ctx.now),
    );
    if (!approval)
      return blocked([
        {
          kind: 'approval',
          step: 'store-concept/assembleSpec',
          subjectHash: hash,
          question: 'Release this store concept for downstream workflows?',
          blocking: true,
        } satisfies Need,
      ]);
    const sources = uniqueRefs([
      assetRef(template),
      assetRef(profile),
      ...selection.sources,
      ...input.calibration.sources,
      ...input.sources,
    ]);
    const records = [template, profile];
    return result(
      StoreSpec.parse({
        kind: 'StoreSpec',
        artifactVersion: '0.1.0',
        id: `store-spec-${hash.slice(0, 32)}`,
        hash,
        producedBy: {
          step: 'store-concept/assembleSpec',
          pkg: '@osw/store-concept',
          pkgVersion: '0.1.0',
        },
        storeId: brief.storeId,
        inputs: brief.inputs ?? [],
        sources,
        createdAt: ctx.now,
        ...(records.every((record) => record.example === true) && input.example
          ? { example: true }
          : {}),
        body,
      }),
    );
  },
};
