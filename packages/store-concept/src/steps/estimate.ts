import { type Need, type StepDef, type Verification, convertMoney } from '@osw/core';
import { compute } from '../engine.js';
import {
  assetRef,
  blocked,
  parameterProvenance,
  result,
  scopeFor,
  withFxParams,
} from '../helpers.js';
import { EstimatedConcept, MenuSelection } from '../models.js';

export const estimate: StepDef<typeof MenuSelection, typeof EstimatedConcept> = {
  id: 'store-concept/estimate',
  input: MenuSelection,
  output: EstimatedConcept,
  reads: ['calc-template', 'params'],
  params: [],
  async run(raw, initialCtx) {
    const selection = MenuSelection.parse(raw);
    const { brief, template } = selection.concept;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    if (!template.data.hasDefaults) {
      for (const param of template.data.params)
        if (brief.overrides?.[param.key] === undefined)
          needs.push({
            kind: 'input',
            path: `overrides.${param.key}`,
            reason: 'Template has no usable defaults; supply this amount explicitly',
            blocking: true,
          });
    }
    if (needs.some((need) => need.blocking)) return blocked(needs);
    const scope = scopeFor(brief, template.data.track);
    const ctx = await withFxParams(initialCtx, [template.data.currency], brief.currency, scope);
    const convert = (amount: number) => {
      const converted = convertMoney(
        { amount, currency: template.data.currency },
        brief.currency,
        ctx.params,
        scope,
      );
      needs.push(...converted.needs);
      return converted.value?.amount;
    };
    const spend = convert(template.data.spend);
    const params = template.data.params.map((param) => {
      if (param.algorithm !== 'fixed' && param.algorithm !== 'area_scale') return param;
      const amount = convert(param.baseValue);
      return { ...param, baseValue: amount ?? param.baseValue };
    });
    if (needs.some((need) => need.blocking) || spend === undefined) return blocked(needs);
    const convertedTemplate = { ...template.data, currency: brief.currency, spend, params };
    const economics = compute({
      template: convertedTemplate,
      areaM2: brief.areaM2 ?? template.data.baseAreaM2,
      overrides: brief.overrides,
      assumptions: brief.assumptions,
    });
    const unverified = template.data.params.filter(
      (param) =>
        brief.overrides?.[param.key] === undefined &&
        (param.provenance.kind === 'estimate' || param.provenance.kind === 'unset'),
    );
    if (!template.data.hasDefaults || unverified.length)
      verifications.push({
        asset: assetRef(template),
        purpose: 'store-concept/estimate',
        verdict: 'pending',
        reason: !template.data.hasDefaults
          ? 'Template has no default amounts; calculations use explicit overrides'
          : `Unverified template amounts: ${unverified.map((param) => param.key).join(', ')}`.slice(
              0,
              500,
            ),
        at: ctx.now,
        by: ctx.actor,
      });
    if (!template.data.staffing)
      needs.push({
        kind: 'asset',
        slot: 'calc-template',
        filter: { field: 'id', op: 'eq', value: template.id },
        reason: 'Template does not define staffing',
        blocking: false,
      });
    const provenance = await parameterProvenance(
      ctx,
      template.data.currency === brief.currency
        ? []
        : [`fx.${template.data.currency}.${brief.currency}`],
      scope,
    );
    return result(
      {
        selection,
        economics,
        sources: provenance.sources,
        example: selection.example && provenance.example,
      },
      needs,
      verifications,
    );
  },
};
