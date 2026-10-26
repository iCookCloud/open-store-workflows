import { type Need, type StepDef, TermSlot, type Verification, roundMoney } from '@osw/core';
import { decimalSum } from '../decimal.js';
import {
  assetRef,
  blocked,
  numericParam,
  parameterProvenance,
  queryAll,
  result,
  scopeFor,
} from '../helpers.js';
import { Calibration, SiteRequirements } from '../models.js';
import { type SpecRequirement, mergeRequirements } from '../requirements.js';

export const deriveSiteRequirements: StepDef<typeof Calibration, typeof SiteRequirements> = {
  id: 'store-concept/deriveSiteRequirements',
  input: Calibration,
  output: SiteRequirements,
  reads: ['site-profile', 'term', 'params'],
  params: [
    { key: 'concept.areaTolerance', required: true, description: 'Relative area tolerance' },
    {
      key: 'concept.minMarginRate',
      required: false,
      description: 'Minimum acceptable net margin for rent ceiling',
    },
  ],
  async run(raw, ctx) {
    const calibration = Calibration.parse(raw);
    const { selection, economics } = calibration.estimate;
    const { brief, template, profile } = selection.concept;
    const scope = scopeFor(brief, template.data.track);
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const tolerance = numericParam(ctx, 'concept.areaTolerance', scope, needs, {
      min: 0,
      max: 1,
      maxExclusive: true,
    });
    const margin = numericParam(ctx, 'concept.minMarginRate', scope, needs, {
      optional: true,
      min: 0,
      max: 1,
    });
    if (tolerance === null) return blocked(needs);
    const targetM2 = brief.areaM2 ?? template.data.baseAreaM2;
    const area = { targetM2, minM2: targetM2 * (1 - tolerance), maxM2: targetM2 * (1 + tolerance) };
    const source = assetRef(profile);
    const requirements: SpecRequirement[] = profile.data.requirements.map((requirement) => ({
      ...requirement,
      basis: 'store-type',
      source,
    }));
    const keys = [
      ...new Set(profile.data.equipmentTriggers.flatMap((trigger) => trigger.termKeys)),
    ];
    const found = new Set<string>();
    const provenance = await parameterProvenance(
      ctx,
      ['concept.areaTolerance', 'concept.minMarginRate'],
      scope,
    );
    const sources = [...provenance.sources];
    let example = calibration.example && provenance.example;
    for (let offset = 0; offset < keys.length; offset += 200) {
      const records = await queryAll(ctx.assets, TermSlot, {
        field: 'key',
        op: 'in',
        value: keys.slice(offset, offset + 200),
      });
      for (const record of records) {
        found.add(record.data.key);
        sources.push(assetRef(record));
        example = example && record.example === true;
      }
    }
    const equipment = new Set(selection.downstream.equipment.map((term) => term.key));
    for (const trigger of profile.data.equipmentTriggers) {
      const missing = trigger.termKeys.filter((key) => !found.has(key));
      if (missing.length)
        verifications.push({
          asset: source,
          purpose: 'store-concept/deriveSiteRequirements',
          verdict: 'fails',
          dimension: `siteRequirements.${trigger.requirement.key}`,
          reason: `Unknown trigger term keys: ${missing.join(', ')}`.slice(0, 500),
          at: ctx.now,
          by: ctx.actor,
        });
      if (trigger.termKeys.some((key) => equipment.has(key)))
        requirements.push({ ...trigger.requirement, basis: 'menu', source });
    }
    requirements.push(
      {
        key: 'area',
        op: 'gte',
        value: area.minM2,
        unit: 'm2',
        hard: true,
        basis: 'estimate',
        reason: 'Minimum area from requested target and tolerance',
      },
      {
        key: 'area',
        op: 'lte',
        value: area.maxM2,
        unit: 'm2',
        hard: true,
        basis: 'estimate',
        reason: 'Maximum area from requested target and tolerance',
      },
    );
    const combined = mergeRequirements(requirements);
    needs.push(...combined.needs);
    const rent = economics.monthly.find((line) => line.key === 'rent');
    const rentCeiling =
      margin !== null &&
      rent &&
      !rent.overridden &&
      (rent.algorithm === 'fixed' || rent.algorithm === 'area_scale')
        ? roundMoney({
            amount:
              economics.totals.monthlyRevenue.amount *
                decimalSum([economics.contributionRate, -margin]) -
              (economics.fixedMonthly - rent.amount.amount),
            currency: brief.currency,
          })
        : null;
    return result(
      { calibration, siteRequirements: combined.requirements, area, rentCeiling, sources, example },
      needs,
      verifications,
    );
  },
};
