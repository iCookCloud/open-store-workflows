import {
  type Need,
  PartySlot,
  type Verification,
  assetRef,
  findApproval,
  getMany,
  isWithin,
  roundMoney,
  sumMoney,
  versionHash,
} from '@osw/core';
import {
  actionNeed,
  approval,
  deliveryStep,
  inputNeed,
  loadFx,
  numericParam,
  queryIn,
  refMatches,
  stepResult,
  verification,
} from '../helpers.js';
import { declarationValue } from '../packing/units.js';
import { rateCardSlot } from '../slots.js';

export const collectQuotes = deliveryStep(
  'collectQuotes',
  ['party', 'rate-card', 'params'],
  async (state, ctx) => {
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    for (const id of Object.keys(state.input.quotes))
      if (!state.plan.shipments.some((shipment) => shipment.id === id))
        needs.push(inputNeed('quotes', 'Unknown shipment ID'));
    const parties = await getMany(
      ctx.assets,
      PartySlot,
      state.plan.shipments.flatMap((shipment) =>
        shipment.carrier.kind === 'forwarder' ? [shipment.carrier.partyRef.id] : [],
      ),
    );
    const cards = await queryIn(
      ctx.assets,
      rateCardSlot,
      'partyId',
      parties.map((record) => record.id),
    );
    for (const shipment of state.plan.shipments) {
      const incoming = state.input.quotes[shipment.id] ?? [];
      if (shipment.carrier.kind !== 'forwarder') {
        if (incoming.length)
          needs.push(inputNeed('quotes', 'Only assigned forwarders submit freight quotes'));
        continue;
      }
      if (shipment.status === 'draft') {
        needs.push(inputNeed('quotes', 'Confirm packing before collecting quotes'));
        continue;
      }
      const party = parties.find(
        (record) =>
          shipment.carrier.kind === 'forwarder' && record.id === shipment.carrier.partyRef.id,
      );
      for (const quote of incoming) {
        if (!party || !refMatches(quote.partyRef, party)) {
          needs.push(
            inputNeed('quotes.partyRef', 'Quote must reference the current assigned forwarder'),
          );
          continue;
        }
        if (
          quote.receivedAt > ctx.now ||
          quote.items.some(
            (item) =>
              item.amount.amount < 0 || item.amount.currency !== quote.items[0].amount.currency,
          ) ||
          (quote.form === 'lump_sum' &&
            (quote.items.length !== 1 || quote.items[0].category !== 'other'))
        ) {
          needs.push(
            inputNeed('quotes', 'Invalid quotation timestamp, currency, amount or lump sum form'),
          );
          continue;
        }
        const existing = shipment.quotes.find((candidate) => candidate.id === quote.id);
        if (existing && (await versionHash(existing)) !== (await versionHash(quote))) {
          needs.push(inputNeed('quotes.id', 'Changed quotations require a new quote ID'));
          continue;
        }
        if (!existing) shipment.quotes.push(structuredClone(quote));
      }
      if (shipment.status === 'confirmed') shipment.status = 'quoting';
      if (!shipment.quotes.length) {
        needs.push(actionNeed('requestFreightQuote', 'Obtain a freight quotation', shipment.id));
        continue;
      }
      const available = shipment.quotes.filter(
        (quote) =>
          party &&
          refMatches(quote.partyRef, party) &&
          (!quote.validUntil || quote.validUntil >= ctx.now.slice(0, 10)) &&
          quote.receivedAt <= ctx.now,
      );
      let chosen = shipment.quotes.find((quote) => quote.id === shipment.chosenQuoteId);
      if (chosen && (!party || !refMatches(chosen.partyRef, party))) {
        needs.push(
          inputNeed(
            'chosenQuoteId',
            'Chosen quote does not belong to the current assigned carrier',
          ),
        );
        continue;
      }
      if (!chosen) {
        const approved = [];
        for (const quote of available) {
          const hash = await versionHash(quote);
          const decision = findApproval(
            ctx.approvals.filter((a) => a.at <= ctx.now),
            'landed-delivery/collectQuotes',
            hash,
            `quote:${quote.id}`,
          );
          if (decision?.role === 'operator' && decision.decision === 'choose') approved.push(quote);
        }
        if (approved.length > 1) {
          needs.push(inputNeed('approvals', 'Choose exactly one quote per shipment'));
          continue;
        }
        chosen = approved[0];
        if (!chosen) {
          if (!available.length)
            needs.push(
              actionNeed(
                'requestFreightQuote',
                'All quotations expired; request a fresh quote',
                shipment.id,
                true,
              ),
            );
          for (const quote of available)
            approval(
              ctx,
              'collectQuotes',
              `quote:${quote.id}`,
              await versionHash(quote),
              ['operator'],
              ['choose'],
              needs,
            );
          continue;
        }
        shipment.chosenQuoteId = chosen.id;
        shipment.freight = sumMoney(chosen.items.map((item) => roundMoney(item.amount)));
        shipment.status = 'booked';
      }
      const acceptance = findApproval(
        ctx.approvals.filter((a) => a.at <= ctx.now && a.role === 'client'),
        'landed-delivery/collectQuotes',
        await versionHash(chosen),
        `quote:${chosen.id}`,
      );
      if (acceptance?.decision === 'accept')
        verifications.push(
          verification(
            ctx,
            'collectQuotes',
            chosen.partyRef,
            'clientAcceptance',
            'holds',
            `Client accepted quote ${chosen.id}`,
          ),
        );
      const applicable = cards.filter(
        (record) =>
          record.data.partyId === chosen!.partyRef.id &&
          isWithin(shipment.origin, record.data.from) &&
          isWithin(state.plan.market, record.data.to) &&
          record.data.mode === shipment.mode &&
          record.data.goodsClass === shipment.goodsClass &&
          record.data.validFrom <= chosen!.receivedAt.slice(0, 10) &&
          record.data.validTo >= chosen!.receivedAt.slice(0, 10),
      );
      for (const card of applicable) {
        const basis = card.data.basis;
        const field =
          basis === 'm3' ? 'totalVolumeM3' : basis === 'kg' ? 'totalGrossWeightKg' : 'cartons';
        if (basis !== 'shipment' && shipment.lines.some((line) => line[field].value === null)) {
          verifications.push(
            verification(
              ctx,
              'collectQuotes',
              assetRef(card),
              'rate',
              'pending',
              'Packing measurements missing for rate comparison',
            ),
          );
          continue;
        }
        const units =
          basis === 'shipment'
            ? 1
            : shipment.lines.reduce((sum, line) => sum + (line[field].value ?? 0), 0);
        const currency = shipment.freight!.currency;
        const fxCtx = await loadFx(
          ctx,
          card.data.rate.currency === currency ? [] : [`fx.${card.data.rate.currency}.${currency}`],
          state.input.jurisdiction,
        );
        const expected = declarationValue(
          card.data.rate,
          units,
          currency,
          state.input.jurisdiction,
          fxCtx,
          needs,
        );
        const tolerance = numericParam(
          ctx,
          'freight.tolerance.rateCardPct',
          state.input.jurisdiction,
          needs,
        );
        if (!expected || tolerance === undefined) continue;
        const actual = shipment.freight!.amount;
        const delta = actual - expected.amount;
        const holds =
          expected.amount === 0 ? actual === 0 : Math.abs(delta) / expected.amount <= tolerance;
        verifications.push(
          verification(
            ctx,
            'collectQuotes',
            assetRef(card),
            'rate',
            holds ? 'holds' : 'fails',
            'Quoted freight compared with lane rate card',
            { field: 'rate', expected: expected.amount, actual, delta, unit: currency },
          ),
        );
      }
    }
    return stepResult(state, needs, verifications);
  },
);
