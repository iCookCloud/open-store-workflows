import { type Need, type StepDef, type Verification, stepResult, versionHash, z } from '@osw/core';
import {
  approval,
  approvalNeed,
  inputNeed,
  parameterRefs,
  parametersAreExamples,
  uniqueRefs,
  verification,
  withParams,
} from '../helpers.js';
import { Estimated, Quoted } from '../models.js';
import { projectClientQuote } from '../rules/client-view.js';
import {
  convertedAmount,
  goodsTotal,
  laborRate,
  money,
  priceFees,
  priceLines,
  repriceQuantities,
  totals,
} from '../rules/price.js';

export const priceQuote: StepDef<typeof Estimated, typeof Quoted> = {
  id: 'build-out/priceQuote',
  input: Estimated,
  output: Quoted,
  reads: ['params'],
  params: [
    { key: 'labor.hourlyRate', required: true, description: 'Installation rate with CUR/h unit' },
  ],
  approval: {
    question: 'Accept or decline this customer quote?',
    decision: z.enum(['accept', 'decline']),
  },
  async run(raw, originalCtx) {
    const state = Estimated.parse(raw);
    const { input } = state;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    let ctx = await withParams(
      originalCtx,
      [
        'labor.hourlyRate',
        ...state.lines.flatMap((l) => (l.trade ? [`labor.hourlyRate.${l.trade}`] : [])),
      ],
      input,
    );
    const baseRate = laborRate(ctx, input, needs);
    const rates = state.lines.map((line) => ({
      line,
      found: laborRate(ctx, input, needs, line.trade),
    }));
    const currencies = [
      ...state.lines.map((l) => l.basePrice.currency),
      ...state.fees.flatMap((f) => (f.rate ? [f.rate.currency] : [])),
      ...rates.flatMap((r) => (r.found ? [r.found.rate.currency] : [])),
      ...(baseRate ? [baseRate.rate.currency] : []),
    ];
    const fxKeys = [
      ...new Set(
        currencies.filter((c) => c !== input.currency).map((c) => `fx.${c}.${input.currency}`),
      ),
    ];
    ctx = await withParams(ctx, fxKeys, input);
    const fxUsed: Record<string, number> = {};
    const basePrices = new Map<string, number>();
    const hourlyRates = new Map<string, number>();
    for (const { line, found } of rates) {
      const base = convertedAmount(line.basePrice, input.currency, ctx, input, needs, fxUsed);
      const rate = found
        ? convertedAmount(found.rate, input.currency, ctx, input, needs, fxUsed)
        : null;
      if (base !== null) basePrices.set(line.id, base);
      if (rate !== null) hourlyRates.set(line.id, rate);
      const source = input.bom.body.lines.find((b) => b.id === line.bomLineId);
      line.partsCheck = 'absent';
      if (source?.parts.length) {
        const model = source.modelCostPerUnit;
        if (
          !model ||
          source.parts.some((p) => p.rate.currency !== model.currency) ||
          line.basePrice.currency !== model.currency
        ) {
          needs.push(
            inputNeed(
              `bom.lines.${source.id}.parts`,
              'Parts verification requires a model cost and consistent currencies',
            ),
          );
          continue;
        }
        const sum = source.parts.reduce((s, p) => s + p.qty * p.rate.amount, 0);
        const unit = ['JPY', 'KRW'].includes(model.currency)
          ? 1
          : ['BHD', 'KWD'].includes(model.currency)
            ? 0.001
            : 0.01;
        const sumHolds = Math.abs(sum - model.amount) <= unit + 1e-10;
        const priceHolds = line.basePrice.amount >= model.amount;
        line.partsCheck = sumHolds && priceHolds ? 'holds' : 'fails';
        for (const ref of input.bom.sources.filter(
          (r) => r.slot === 'bom-case' || r.id === source.derivedFrom.ref,
        )) {
          const target = { ...ref, path: ref.path ?? `/lines/${source.id}` };
          verifications.push(
            verification(
              ctx,
              target,
              priceQuote.id,
              'partsSum',
              model.amount,
              sum,
              sumHolds,
              model.currency,
            ),
          );
          verifications.push(
            verification(
              ctx,
              target,
              priceQuote.id,
              'priceVsModelCost',
              model.amount,
              line.basePrice.amount,
              priceHolds,
              model.currency,
            ),
          );
        }
      }
    }
    const fees = state.fees
      .filter((f) => !input.options.selfFreight || !f.freight)
      .map((fee) => {
        if (!fee.rate) return fee;
        const amount = convertedAmount(fee.rate, input.currency, ctx, input, needs, fxUsed);
        return { ...fee, rate: { amount: amount ?? 0, currency: input.currency } };
      });
    const convertedRate = baseRate
      ? convertedAmount(baseRate.rate, input.currency, ctx, input, needs, fxUsed)
      : null;
    if (needs.some((n) => n.blocking) || convertedRate === null)
      return { output: null, needs, verifications };
    const lines = priceLines(
      state.lines,
      hourlyRates,
      basePrices,
      input.currency,
      input.options.selfInstall,
    );
    const goods = goodsTotal(lines, fxUsed, input.currency);
    const pricedFees = priceFees(fees, lines, goods, input.currency, needs);
    const quote: Quoted['quote'] = {
      currency: input.currency,
      lines,
      fees: pricedFees,
      laborRate: money(convertedRate, input.currency),
      fxUsed,
      options: input.options,
      totals: totals(lines, pricedFees, goods, input.currency, input.options.selfInstall),
      status: 'draft',
      quoteHash: '0'.repeat(64),
    };
    quote.quoteHash = await versionHash(projectClientQuote(quote, input));
    const previous = input.previousPlan;
    if (previous?.body.quote.status === 'accepted') {
      if (
        previous.storeId !== input.bom.storeId ||
        previous.hash !== (await versionHash(previous.body))
      )
        needs.push(
          inputNeed('previousPlan', 'Previous plan must be an intact artifact for this store'),
        );
      const quantities = new Map(previous.body.quote.lines.map((line) => [line.id, line.qty]));
      const effective = previous.body.changes.filter((change) => change.status === 'effective');
      for (const { status: _status, ...change } of effective) {
        const current = input.changes.find((item) => item.id === change.id);
        if (!current || (await versionHash(current)) !== (await versionHash(change)))
          needs.push(
            inputNeed(
              `changes.${change.id}`,
              'Previously effective changes must be retained unchanged; use a new signed reversing change',
            ),
          );
        for (const delta of change.lineDeltas)
          quantities.set(delta.lineId, (quantities.get(delta.lineId) ?? 0) - delta.qtyDelta);
      }
      if ([...quantities.values()].some((qty) => qty < 0))
        needs.push(
          inputNeed(
            'previousPlan.changes',
            'Prior change history cannot reconstruct nonnegative original quantities',
          ),
        );
      // 从前次最终报价倒推出原始签价，再由 track 顺序重放变更，避免把已批增量算两遍。
      const original = repriceQuantities(previous.body.quote, quantities, needs);
      const originalHash = await versionHash(projectClientQuote(original, input));
      if (originalHash !== quote.quoteHash)
        needs.push({
          kind: 'action',
          action: 'changeOrder',
          reason: 'An accepted quote can only change through a signed change order',
          blocking: true,
        });
    }
    const consent = approval(ctx, priceQuote.id, quote.quoteHash, 'client');
    if (!consent || !['accept', 'decline'].includes(consent.decision))
      needs.push(
        approvalNeed(
          priceQuote.id,
          quote.quoteHash,
          'Client must accept or decline this quote version',
        ),
      );
    else if (consent.decision === 'decline') {
      quote.status = 'declined';
      needs.push({
        kind: 'action',
        action: 'reviseQuote',
        reason: 'Client declined this quote',
        blocking: true,
      });
    } else {
      quote.status = 'accepted';
      quote.acceptedAt = consent.at;
    }
    const keys = [
      'labor.hourlyRate',
      ...rates.flatMap((r) => (r.found ? [r.found.key] : [])),
      ...fxKeys,
    ];
    return stepResult(
      Quoted.parse({
        input,
        quote,
        sources: uniqueRefs([...state.sources, ...parameterRefs(ctx, keys, input)]),
        example: state.example && (await parametersAreExamples(ctx, keys, input)),
      }),
      needs,
      verifications,
    );
  },
};
