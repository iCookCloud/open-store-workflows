import {
  type Need,
  type StepDef,
  StoreSlot,
  type Verification,
  convertMoney,
  isWithin,
  roundMoney,
} from '@osw/core';
import {
  assetRef,
  blocked,
  numericParam,
  parameterProvenance,
  queryAll,
  result,
  scopeFor,
  uniqueRefs,
  withFxParams,
} from '../helpers.js';
import { Calibration, EstimatedConcept } from '../models.js';

export const calibrate: StepDef<typeof EstimatedConcept, typeof Calibration> = {
  id: 'store-concept/calibrate',
  input: EstimatedConcept,
  output: Calibration,
  reads: ['store', 'params'],
  params: [
    {
      key: 'concept.budgetBand',
      required: true,
      description: 'Fallback investment uncertainty band',
    },
    {
      key: 'concept.calibrationMinSample',
      required: true,
      description: 'Minimum independent complete store samples',
    },
    {
      key: 'verify.calcTemplateTolerance',
      required: true,
      description: 'Allowed relative calibration deviation',
    },
  ],
  async run(raw, initialCtx) {
    const estimate = EstimatedConcept.parse(raw);
    const { brief, template } = estimate.selection.concept;
    const scope = scopeFor(brief, template.data.track);
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const band = numericParam(initialCtx, 'concept.budgetBand', scope, needs, {
      min: 0,
      max: 1,
      maxExclusive: true,
    });
    const minimum = numericParam(initialCtx, 'concept.calibrationMinSample', scope, needs, {
      min: 1,
      integer: true,
    });
    const tolerance = numericParam(initialCtx, 'verify.calcTemplateTolerance', scope, needs, {
      min: 0,
    });
    if (band === null || minimum === null || tolerance === null) return blocked(needs);
    // storeType 是非餐饮与未填 cuisine 门店都能使用的精确业态键。
    const stores = (
      await queryAll(initialCtx.assets, StoreSlot, {
        all: [
          { field: 'status', op: 'eq', value: 'operating' },
          { field: 'storeType', op: 'eq', value: template.data.storeType },
        ],
      })
    ).filter(
      (store) =>
        store.data.track === template.data.track &&
        isWithin(brief.jurisdiction, store.data.jurisdiction),
    );
    const ctx = await withFxParams(
      initialCtx,
      stores.flatMap((store) => (store.data.actuals ?? []).map((actual) => actual.amount.currency)),
      brief.currency,
      scope,
    );
    const targetArea = brief.areaM2 ?? template.data.baseAreaM2;
    const amounts = new Map<string, number[]>();
    const completeTotals: number[] = [];
    const sources = [...estimate.sources];
    let example = estimate.example;
    const usedFxKeys = new Set<string>();
    const money = (amount: number) => roundMoney({ amount, currency: brief.currency });
    for (const store of stores) {
      if (!store.data.actuals?.length) continue;
      const normalized = new Map<string, number>();
      let used = false;
      for (const line of estimate.economics.investment) {
        const param = template.data.params.find((param) => param.key === line.key)!;
        if (line.overridden || param.provenance.storeIds.includes(store.id)) continue;
        if (param.algorithm === 'area_scale' && (!store.data.areaM2 || store.data.areaM2 <= 0))
          continue;
        // 同科目多个账目是不同支付凭据，优先 paid 口径，避免把承诺额与实付重复相加。
        const actuals = store.data.actuals.filter((actual) => actual.key === line.key);
        const paid = actuals.filter((actual) => actual.basis === 'paid');
        const selected = paid.length
          ? paid
          : actuals.filter((actual) => actual.basis === 'committed');
        if (!selected.length) continue;
        let amount = 0;
        let convertedAll = true;
        for (const actual of selected) {
          const converted = convertMoney(actual.amount, brief.currency, ctx.params, scope);
          needs.push(...converted.needs);
          if (!converted.value) {
            convertedAll = false;
            continue;
          }
          amount += converted.value.amount;
          if (actual.amount.currency !== brief.currency)
            usedFxKeys.add(`fx.${actual.amount.currency}.${brief.currency}`);
        }
        if (!convertedAll) continue;
        amount = money(
          amount * (param.algorithm === 'area_scale' ? targetArea / store.data.areaM2! : 1),
        ).amount;
        normalized.set(line.key, amount);
        const previous = amounts.get(line.key) ?? [];
        previous.push(amount);
        amounts.set(line.key, previous);
        used = true;
        const expected = line.amount.amount;
        const delta = amount - expected;
        const relative =
          expected === 0
            ? amount === 0
              ? 0
              : Number.POSITIVE_INFINITY
            : Math.abs(delta) / Math.abs(expected);
        verifications.push({
          asset: assetRef(template),
          purpose: 'store-concept/calibrate',
          dimension: `investment.${line.key}`,
          verdict: relative <= tolerance ? 'holds' : 'fails',
          reason: `Independent store ${store.id} normalized actual compared with template`,
          measured: {
            field: `investment.${line.key}`,
            expected,
            actual: amount,
            unit: brief.currency,
            delta,
          },
          evidence: [`sha256:${store.versionHash}`],
          at: ctx.now,
          by: ctx.actor,
        });
      }
      if (used) {
        sources.push(assetRef(store));
        example = example && store.example === true;
      }
      const independent = estimate.economics.investment.filter((line) => !line.overridden);
      if (independent.length && independent.every((line) => normalized.has(line.key))) {
        completeTotals.push(
          estimate.economics.investment.reduce(
            (sum, line) => sum + (line.overridden ? line.amount.amount : normalized.get(line.key)!),
            0,
          ),
        );
      }
    }
    if (needs.some((need) => need.blocking)) return blocked(needs, verifications);
    const provenance = await parameterProvenance(
      ctx,
      [
        'concept.budgetBand',
        'concept.calibrationMinSample',
        'verify.calcTemplateTolerance',
        ...usedFxKeys,
      ],
      scope,
    );
    sources.push(...provenance.sources);
    example = example && provenance.example;
    const investment = estimate.economics.investment.map((line) => {
      const samples = amounts.get(line.key) ?? [];
      return {
        ...line,
        range:
          !line.overridden && samples.length >= minimum
            ? { low: money(Math.min(...samples)), high: money(Math.max(...samples)) }
            : {
                low: money(line.amount.amount * (1 - band)),
                high: money(line.amount.amount * (1 + band)),
              },
      };
    });
    const actuals = completeTotals.length >= minimum;
    const total = estimate.economics.totals.investment.amount;
    const budgetRange = {
      low: money(actuals ? Math.min(...completeTotals) : total * (1 - band)),
      high: money(actuals ? Math.max(...completeTotals) : total * (1 + band)),
      basis: actuals ? ('actuals' as const) : ('band' as const),
      sampleSize: completeTotals.length,
    };
    if (brief.budgetCap && budgetRange.low.amount > brief.budgetCap.amount)
      needs.push({
        kind: 'action',
        action: 'rescopeConcept',
        reason: 'Even the lower investment estimate exceeds the supplied budget cap',
        blocking: true,
      });
    return result(
      { estimate, investment, budgetRange, sources: uniqueRefs(sources), example },
      needs,
      verifications,
    );
  },
};
