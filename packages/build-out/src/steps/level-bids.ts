import {
  type Need,
  OfferSlot,
  PartySlot,
  type StepDef,
  type Verification,
  assetRef,
  convertUnit,
  getMany,
  isWithin,
  stepResult,
  unitPriceAt,
  versionHash,
  z,
} from '@osw/core';
import {
  PARAMS,
  approval,
  approvalNeed,
  inputNeed,
  numericParam,
  parameterRefs,
  parametersAreExamples,
  uniqueRefs,
  verification,
  withParams,
  withinPct,
} from '../helpers.js';
import { Bids, Quoted } from '../models.js';
import { convertedAmount, money } from '../rules/price.js';

export const levelBids: StepDef<typeof Quoted, typeof Bids> = {
  id: 'build-out/levelBids',
  input: Quoted,
  output: Bids,
  reads: ['offer', 'party', 'params'],
  params: PARAMS.filter((p) =>
    ['build.minBids', 'verify.installHours.tolerancePct'].includes(p.key),
  ),
  approval: { question: 'Proceed with fewer contractor bids?', decision: z.enum(['proceed']) },
  async run(raw, originalCtx) {
    const state = Quoted.parse(raw);
    const { input, quote } = state;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const offers = await getMany(originalCtx.assets, OfferSlot, [...new Set(input.offerIds)]);
    const parties = await getMany(originalCtx.assets, PartySlot, [
      ...new Set(offers.map((o) => o.data.partyId)),
    ]);
    const fxKeys = [
      ...new Set(
        offers
          .map((o) => o.data.currency)
          .filter((c) => c !== quote.currency)
          .map((c) => `fx.${c}.${quote.currency}`),
      ),
    ];
    const ctx = await withParams(originalCtx, fxKeys, input);
    const minimum = numericParam(ctx, 'build.minBids', input, needs, false, true);
    const tolerance = offers.some((o) => o.data.hoursPerUnit !== undefined)
      ? numericParam(ctx, 'verify.installHours.tolerancePct', input, needs)
      : null;
    const sources = [
      ...state.sources,
      ...parameterRefs(
        ctx,
        [
          'build.minBids',
          ...(tolerance === null ? [] : ['verify.installHours.tolerancePct']),
          ...fxKeys,
        ],
        input,
      ),
    ];
    const byParty = new Map<
      string,
      {
        offerRefs: Bids['bids'][number]['offerRefs'];
        total: number;
        covered: Set<string>;
        hours: number;
        allHours: boolean;
      }
    >();
    const date = ctx.now.slice(0, 10);
    for (const id of new Set(input.offerIds))
      if (!offers.some((o) => o.id === id))
        needs.push({
          kind: 'asset',
          slot: 'offer',
          filter: { field: 'id', op: 'eq', value: id },
          reason: 'Requested bid is missing',
          blocking: true,
        });
    for (const record of offers) {
      const offer = record.data;
      const party = parties.find((p) => p.id === offer.partyId);
      if (
        !party ||
        party.data.status !== 'active' ||
        !party.data.roles.some((r) => ['contractor', 'installer'].includes(r)) ||
        !party.data.profiles?.contractor?.trades.length ||
        (party.data.jurisdictions?.length &&
          !party.data.jurisdictions.some((j) => isWithin(input.site.body.jurisdiction, j)))
      ) {
        needs.push(
          inputNeed(
            `offers.${record.id}.partyId`,
            'Bid needs an active contractor serving this jurisdiction',
          ),
        );
        continue;
      }
      if (
        !offer.serviceScope ||
        offer.productId ||
        offer.use !== 'project' ||
        offer.quotedAt > date ||
        (offer.validFrom && offer.validFrom > date) ||
        (offer.validUntil && offer.validUntil < date)
      ) {
        needs.push(inputNeed(`offers.${record.id}`, 'Bid must be a current project service offer'));
        continue;
      }
      const ids = [...new Set(offer.serviceLineRefs ?? [])];
      const lines = quote.lines.filter((l) => ids.includes(l.id));
      if (!ids.length || ids.length !== lines.length) {
        needs.push(
          inputNeed(
            `offers.${record.id}.serviceLineRefs`,
            'Bid must explicitly reference known construction lines',
          ),
        );
        continue;
      }
      const group = byParty.get(party.id) ?? {
        offerRefs: [],
        total: 0,
        covered: new Set<string>(),
        hours: 0,
        allHours: true,
      };
      if (ids.some((id) => group.covered.has(id))) {
        needs.push(
          inputNeed(
            `offers.${record.id}.serviceLineRefs`,
            'Overlapping offers from one contractor would double count work',
          ),
        );
        continue;
      }
      let qty = offer.unit === 'lot' ? 1 : 0;
      if (offer.unit !== 'lot') {
        for (const line of lines) {
          const converted = convertUnit(line.qty, line.unit, offer.unit);
          needs.push(...converted.needs);
          if (converted.value !== null) qty += converted.value;
        }
      }
      const price = unitPriceAt(offer, qty);
      if (!price) {
        needs.push(
          inputNeed(`offers.${record.id}.tiers`, 'No applicable tier or minimum order not met'),
        );
        continue;
      }
      const amount = convertedAmount(
        { ...price, amount: price.amount * qty },
        quote.currency,
        ctx,
        input,
        needs,
        {},
      );
      if (amount === null) continue;
      group.total += money(amount, quote.currency).amount;
      group.offerRefs.push(assetRef(record));
      for (const id of ids) group.covered.add(id);
      group.allHours &&= offer.hoursPerUnit !== undefined;
      if (offer.hoursPerUnit !== undefined) {
        const hours = offer.hoursPerUnit * qty;
        group.hours += hours;
        const expected = lines.reduce((s, l) => s + l.qty * l.install.hoursPerUnit, 0);
        const totalQty = lines.reduce((s, l) => s + l.qty, 0);
        if (totalQty > 0 && tolerance !== null)
          for (const ref of uniqueRefs(
            lines.flatMap((l) =>
              !l.install.overridden && l.install.rateRef ? [l.install.rateRef] : [],
            ),
          ))
            verifications.push(
              verification(
                ctx,
                ref,
                levelBids.id,
                'hoursPerUnit',
                expected / totalQty,
                hours / totalQty,
                withinPct(hours, expected, tolerance),
                'h',
              ),
            );
      }
      sources.push(assetRef(record), assetRef(party));
      byParty.set(party.id, group);
    }
    const bids: Bids['bids'] = [...byParty]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([partyId, group]) => ({
        partyId,
        offerRefs: group.offerRefs,
        total: money(group.total, quote.currency),
        missingLineIds: quote.lines.filter((l) => !group.covered.has(l.id)).map((l) => l.id),
        ...(group.allHours ? { hours: group.hours } : {}),
      }));
    if (minimum !== null && bids.length < minimum) {
      const hash = await versionHash({ quoteHash: quote.quoteHash, bids, minimum });
      const consent = approval(ctx, levelBids.id, hash, 'operator');
      if (consent?.decision !== 'proceed' || !consent.note?.trim()) {
        needs.push(
          approvalNeed(
            levelBids.id,
            hash,
            'Proceed below the bid minimum with an operator explanation',
          ),
        );
        needs.push({
          kind: 'action',
          action: 'requestBids',
          reason: `Only ${bids.length} distinct bids against minimum ${minimum}`,
          blocking: false,
        });
      }
    }
    return stepResult(
      Bids.parse({
        ...state,
        bids,
        sources: uniqueRefs(sources),
        example:
          state.example &&
          (await parametersAreExamples(
            ctx,
            [
              'build.minBids',
              ...(tolerance === null ? [] : ['verify.installHours.tolerancePct']),
              ...fxKeys,
            ],
            input,
          )) &&
          offers.every((r) => r.example === true) &&
          parties.every((r) => r.example === true),
      }),
      needs,
      verifications,
    );
  },
};
