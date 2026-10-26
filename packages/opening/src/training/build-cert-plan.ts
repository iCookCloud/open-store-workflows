import { AssetRef, type Need, type StepDef, TemplateSlot, assetRef, z } from '@osw/core';
import { selectTemplate } from '../helpers.js';
import { CertSlot } from '../slots/cert.js';
import { CertPlanContent } from '../templates/cert-plan.js';
import {
  inputNeed,
  jurisdictionFit,
  numericTrainingParam,
  parseInput,
  readTrainingRef,
  trackFilter,
  trainingQuery,
  trainingResult,
  uniqueTrainingRefs,
} from './helpers.js';
import { PlanItem, PlanOutput, TrainingScope } from './models.js';
export const BuildCertPlanInput = TrainingScope.extend({
  templateRef: AssetRef.optional(),
  items: z.array(PlanItem).optional(),
});
export const buildCertPlan: StepDef<typeof BuildCertPlanInput, typeof PlanOutput> = {
  id: 'opening/buildCertPlan',
  input: BuildCertPlanInput,
  output: PlanOutput,
  reads: ['template', 'cert', 'params'],
  params: [
    {
      key: 'training.minPassScore',
      required: true,
      description: 'Minimum permitted written or scenario passing score',
      unit: 'percent',
    },
  ],
  async run(raw, ctx) {
    const parsed = parseInput(BuildCertPlanInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    const minimum = numericTrainingParam(ctx, 'training.minPassScore', input, needs, 0, 100);
    const selection = await selectTemplate(
      ctx,
      'cert-plan',
      input.track,
      input.jurisdiction,
      CertPlanContent,
      input.templateRef,
    );
    needs.push(...selection.needs);
    const template = selection.record;
    if (!template || !selection.content) return trainingResult(null, needs);
    const content = { data: selection.content };
    const certs = await trainingQuery(ctx.assets, CertSlot, {
      field: 'standard',
      op: 'eq',
      value: content.data.standard,
    });
    if (new Set(certs.map((c) => c.data.key)).size !== certs.length)
      needs.push(inputNeed('cert', 'Certification keys are ambiguous'));
    const applicable = certs.filter(
      (c) => jurisdictionFit(input.jurisdiction, c.coverage.jurisdictions) !== 'no',
    );
    const generated = applicable.map((cert) => ({
      ...cert.data,
      ref: assetRef(cert),
      enabled:
        cert.data.locked ||
        (content.data.groups.includes(cert.data.group) &&
          !content.data.excludeKeys.includes(cert.data.key)),
      checks: content.data.checks[cert.data.key] ?? cert.data.defaultChecks,
    }));
    const items: z.infer<typeof PlanItem>[] = input.items ?? generated;
    if (new Set(items.map((c) => c.key)).size !== items.length)
      needs.push(inputNeed('items', 'Certification plan keys must be unique'));
    const byKey = new Map(items.map((item) => [item.key, item]));
    for (const cert of applicable) {
      const item = byKey.get(cert.data.key);
      if (
        cert.data.locked &&
        (!item || !item.enabled || !item.locked || item.critical !== cert.data.critical)
      )
        needs.push(
          inputNeed(
            `items.${cert.data.key}`,
            'Locked certification cannot be omitted, disabled or weakened',
          ),
        );
      if (item && !item.ref)
        needs.push(
          inputNeed(
            `items.${item.key}.ref`,
            'Catalog certifications must retain their source reference',
          ),
        );
      if (
        cert.data.locked &&
        item &&
        (JSON.stringify(item.requires) !== JSON.stringify(cert.data.requires) ||
          JSON.stringify(item.positions) !== JSON.stringify(cert.data.positions) ||
          item.recertMonths !== cert.data.recertMonths ||
          item.stationKey !== cert.data.stationKey ||
          (cert.data.defaultChecks.length > 0 && item.checks.length === 0))
      )
        needs.push(
          inputNeed(`items.${item.key}`, 'Locked certification requirements cannot be weakened'),
        );
      if (item?.ref && (item.ref.id !== cert.id || item.ref.versionHash !== cert.versionHash))
        needs.push(
          inputNeed(
            `items.${item.key}.ref`,
            'Certification plan references a changed asset version',
          ),
        );
      if (
        item?.enabled &&
        jurisdictionFit(input.jurisdiction, cert.coverage.jurisdictions) === 'unsure'
      )
        needs.push(
          inputNeed(
            `items.${item.key}.jurisdiction`,
            'Certification jurisdiction requires confirmation',
            false,
          ),
        );
    }
    for (const item of items) {
      if (item.standard !== content.data.standard)
        needs.push(
          inputNeed(
            `items.${item.key}.standard`,
            'Certification standard differs from the template',
          ),
        );
      if (item.passScore !== undefined && minimum !== null && item.passScore < minimum)
        needs.push(
          inputNeed(
            `items.${item.key}.passScore`,
            'Passing score cannot be lower than the configured minimum',
          ),
        );
      if (
        item.ref &&
        !applicable.some((c) => c.id === item.ref?.id && c.versionHash === item.ref.versionHash)
      )
        needs.push(
          inputNeed(`items.${item.key}.ref`, 'Certification is not applicable to this plan'),
        );
    }
    if (!items.some((item) => item.enabled && item.critical))
      needs.push(inputNeed('items', 'At least one enabled critical certification is required'));
    const refs = [
      assetRef(template),
      ...applicable.map((c) => assetRef(c)),
      ...(ctx.params.refs?.('training.minPassScore', input) ?? []),
    ];
    return trainingResult(
      { plan: assetRef(template), items, sources: uniqueTrainingRefs(refs) },
      needs,
    );
  },
};
