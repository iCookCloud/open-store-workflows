import {
  type AssetRecordOf,
  BudgetKey,
  type Need,
  type StepDef,
  type Store,
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

interface InvestmentDefinition {
  key: BudgetKey;
  algorithm: EstimatedConcept['economics']['investment'][number]['algorithm'];
  overridden: boolean;
  amount: number;
  sourceStoreIds: readonly string[];
}

function investmentDefinitions(estimate: EstimatedConcept): InvestmentDefinition[] {
  const { brief, template } = estimate.selection.concept;
  const parameters = new Map(
    template.data.params
      .filter((param) => param.kind === 'investment')
      .map((param) => [param.key as BudgetKey, param]),
  );
  const outputs = new Map(estimate.economics.investment.map((line) => [line.key, line]));
  const keys = new Set<BudgetKey>([...parameters.keys(), ...outputs.keys()]);
  for (const key of Object.keys(brief.overrides ?? {})) {
    const parsed = BudgetKey.safeParse(key);
    if (parsed.success) keys.add(parsed.data);
  }
  // 输出只锁定正金额，源店分母仍须保留被用户覆盖为零的原投资科目。
  return [...keys].map((key) => ({
    key,
    algorithm: outputs.get(key)?.algorithm ?? parameters.get(key)?.algorithm ?? 'fixed',
    overridden: brief.overrides?.[key] !== undefined,
    amount: outputs.get(key)?.amount.amount ?? 0,
    sourceStoreIds: parameters.get(key)?.provenance.storeIds ?? [],
  }));
}

function planStore(
  store: AssetRecordOf<Store>,
  definitions: readonly InvestmentDefinition[],
  outputKeys: ReadonlySet<BudgetKey>,
) {
  const selected = new Map<BudgetKey, NonNullable<Store['actuals']>>();
  for (const line of definitions) {
    const actuals = (store.data.actuals ?? []).filter((actual) => actual.key === line.key);
    const paid = actuals.filter((actual) => actual.basis === 'paid');
    const chosen = paid.length ? paid : actuals.filter((actual) => actual.basis === 'committed');
    if (chosen.length) selected.set(line.key, chosen);
  }
  const independent = new Set(
    definitions
      .filter(
        (line) =>
          !line.overridden &&
          !line.sourceStoreIds.includes(store.id) &&
          selected.has(line.key) &&
          (line.algorithm !== 'area_scale' || Boolean(store.data.areaM2 && store.data.areaM2 > 0)),
      )
      .map((line) => line.key),
  );
  const needed = new Set(
    definitions
      .filter(
        (line) =>
          outputKeys.has(line.key) &&
          independent.has(line.key) &&
          line.algorithm !== 'subtotal_percent',
      )
      .map((line) => line.key),
  );
  const subtotals = definitions.filter(
    (line) =>
      outputKeys.has(line.key) &&
      independent.has(line.key) &&
      line.algorithm === 'subtotal_percent',
  );
  const readySubtotals = new Set<BudgetKey>();
  for (const subtotal of subtotals) {
    const base = definitions.filter((line) => line.key !== subtotal.key);
    if (
      !base.every(
        (line) => selected.has(line.key) && (line.overridden || independent.has(line.key)),
      )
    )
      continue;
    readySubtotals.add(subtotal.key);
    needed.add(subtotal.key);
    for (const line of base) needed.add(line.key);
  }
  return { store, selected, independent, needed, subtotals, readySubtotals };
}

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
        (isWithin(brief.jurisdiction, store.data.jurisdiction) ||
          isWithin(store.data.jurisdiction, brief.jurisdiction)),
    );
    const definitions = investmentDefinitions(estimate);
    const outputKeys = new Set(estimate.economics.investment.map((line) => line.key));
    const plans = stores.map((store) => planStore(store, definitions, outputKeys));
    const ctx = await withFxParams(
      initialCtx,
      plans.flatMap((plan) =>
        [...plan.needed].flatMap((key) =>
          plan.selected.get(key)!.map((actual) => actual.amount.currency),
        ),
      ),
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
    for (const plan of plans) {
      const { store } = plan;
      if (!store.data.actuals?.length) continue;
      const normalized = new Map<string, number>();
      const sourceAmounts = new Map<string, number>();
      let used = false;
      const lines = estimate.economics.investment;
      // 先按独立验证及真实小计依赖筛选，再加载汇率与换币。
      for (const key of plan.needed) {
        const selected = plan.selected.get(key)!;
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
        if (convertedAll) sourceAmounts.set(key, money(amount).amount);
      }
      for (const line of definitions) {
        if (line.overridden) {
          normalized.set(line.key, line.amount);
          continue;
        }
        if (
          !plan.independent.has(line.key) ||
          !sourceAmounts.has(line.key) ||
          line.algorithm === 'subtotal_percent'
        )
          continue;
        normalized.set(
          line.key,
          money(
            sourceAmounts.get(line.key)! *
              (line.algorithm === 'area_scale' ? targetArea / store.data.areaM2! : 1),
          ).amount,
        );
      }
      for (const line of plan.subtotals) {
        const baseLines = definitions.filter((base) => base.key !== line.key);
        const complete =
          plan.readySubtotals.has(line.key) &&
          sourceAmounts.has(line.key) &&
          baseLines.every((base) => sourceAmounts.has(base.key) && normalized.has(base.key));
        const sourceSubtotal = baseLines.reduce(
          (sum, base) => sum + (sourceAmounts.get(base.key) ?? 0),
          0,
        );
        if (!complete || sourceSubtotal <= 0) {
          verifications.push({
            asset: assetRef(template),
            purpose: 'store-concept/calibrate',
            dimension: `investment.${line.key}`,
            verdict: 'pending',
            reason: 'Source-store subtotal is missing or cannot support independent normalization',
            evidence: [`sha256:${store.versionHash}`],
            at: ctx.now,
            by: ctx.actor,
          });
          used = true;
          continue;
        }
        const targetSubtotal = baseLines.reduce((sum, base) => sum + normalized.get(base.key)!, 0);
        normalized.set(
          line.key,
          money((sourceAmounts.get(line.key)! / sourceSubtotal) * targetSubtotal).amount,
        );
      }
      for (const line of lines) {
        if (line.overridden || !normalized.has(line.key)) continue;
        const amount = normalized.get(line.key)!;
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
