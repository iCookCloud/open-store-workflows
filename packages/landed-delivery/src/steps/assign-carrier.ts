import {
  type Filter,
  type Need,
  PartySlot,
  ProductSlot,
  assetRef,
  getMany,
  isWithin,
  jurisdictionPrefixes,
  versionHash,
} from '@osw/core';
import {
  approval,
  assetNeed,
  compare,
  deliveryStep,
  inputNeed,
  queryAll,
  stepResult,
} from '../helpers.js';

export const HANDLING = [
  'cold_chain',
  'frozen',
  'special_customs',
  'ddp',
  'importer_of_record',
  'fda_food',
  'hazmat',
  'liftgate',
  'small_vehicle',
] as const;
export const assignCarrier = deliveryStep(
  'assignCarrier',
  ['party', 'product'],
  async (state, ctx) => {
    const needs: Need[] = [];
    for (const id of Object.keys(state.input.carriers))
      if (!state.plan.shipments.some((shipment) => shipment.id === id))
        needs.push(inputNeed('carriers', 'Unknown shipment ID'));
    const products = await getMany(
      ctx.assets,
      ProductSlot,
      state.plan.shipments.flatMap((shipment) =>
        shipment.lines.flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
      ),
    );
    const cache = new Map<string, Awaited<ReturnType<typeof queryAll<typeof PartySlot.schema>>>>();
    for (const shipment of state.plan.shipments) {
      const selection = state.input.carriers[shipment.id];
      if (shipment.status !== 'draft' && !selection) continue;
      if (shipment.status !== 'draft' && selection) {
        const current = shipment.carrier;
        const same =
          selection.kind === current.kind &&
          (selection.kind === 'own' && current.kind === 'own'
            ? selection.name === current.name && selection.contact === current.contact
            : selection.kind === 'forwarder' && current.kind === 'forwarder'
              ? selection.partyId === current.partyRef.id
              : selection.kind === 'seller');
        if (same) continue;
        if (
          shipment.status === 'shipped' ||
          shipment.status === 'received' ||
          !selection.reason?.trim()
        ) {
          needs.push(
            inputNeed(
              'carriers',
              'Changing a confirmed carrier needs a reason and must precede departure',
            ),
          );
          continue;
        }
      }
      const required = new Set<string>(shipment.lastMile);
      for (const line of shipment.lines) {
        const product = products.find((record) => record.id === line.productRef?.id)?.data;
        for (const tag of product?.handlingTags ?? [])
          if (HANDLING.some((known) => known === tag)) required.add(tag);
        if (product?.storage === 'chilled') required.add('cold_chain');
        if (product?.storage === 'frozen') {
          required.add('cold_chain');
          required.add('frozen');
        }
      }
      const predicates: Filter[] = [
        { field: 'roles', op: 'hasAny', value: ['forwarder'] },
        { field: 'status', op: 'in', value: ['active', 'standby'] },
        { field: 'profiles.forwarder.goodsClasses', op: 'hasAny', value: [shipment.goodsClass] },
        {
          field: 'profiles.forwarder.lanes[].from',
          op: 'in',
          value: jurisdictionPrefixes(shipment.origin),
        },
      ];
      if (required.size)
        predicates.push({
          field: 'profiles.forwarder.handling',
          op: 'hasAll',
          value: [...required].sort(),
        });
      let candidates: Awaited<ReturnType<typeof queryAll<typeof PartySlot.schema>>> = [];
      if (shipment.crossBorder && shipment.carrier.kind !== 'seller' && selection?.kind !== 'own') {
        const key = JSON.stringify(predicates);
        if (!cache.has(key))
          cache.set(key, await queryAll(ctx.assets, PartySlot, { all: predicates }));
        candidates = cache
          .get(key)!
          .filter((record) =>
            record.data.profiles?.forwarder?.lanes.some(
              (lane) =>
                isWithin(shipment.origin, lane.from) &&
                isWithin(state.plan.market, lane.to) &&
                lane.modes.includes(shipment.mode),
            ),
          );
        candidates.sort(
          (a, b) =>
            Number(a.data.status === 'standby') - Number(b.data.status === 'standby') ||
            a.data.profiles!.forwarder!.rank - b.data.profiles!.forwarder!.rank ||
            compare(a.id, b.id),
        );
      }
      state.candidates[shipment.id] = candidates.map((record) => assetRef(record));
      if (shipment.carrier.kind !== 'seller' && selection?.kind !== 'own' && !candidates.length) {
        needs.push(
          assetNeed(
            'party',
            `${shipment.id}: no matching carrier for ${shipment.origin} → ${state.plan.market}, ${shipment.mode}, ${shipment.goodsClass}; handling ${[...required].join(',')}. Supply an own carrier if appropriate.`,
            true,
            { all: predicates },
          ),
        );
        continue;
      }
      const decisions =
        shipment.carrier.kind === 'seller'
          ? ['seller']
          : selection?.kind === 'own'
            ? ['own']
            : candidates.map((record) => `forwarder:${record.id}`);
      const subjectHash = await versionHash({
        origin: shipment.origin,
        market: state.plan.market,
        goodsClass: shipment.goodsClass,
        mode: shipment.mode,
        lines: shipment.lines.map((line) => line.id).sort(),
        required: [...required].sort(),
        candidates: state.candidates[shipment.id],
        selection: selection ?? null,
        seller: shipment.carrier.kind === 'seller' ? shipment.carrier.partyRef : null,
      });
      const chosen = approval(
        ctx,
        'assignCarrier',
        `shipment:${shipment.id}`,
        subjectHash,
        ['operator'],
        decisions,
        needs,
      );
      if (!chosen) continue;
      const before = structuredClone(shipment.carrier);
      if (chosen.decision === 'own' && selection?.kind === 'own')
        shipment.carrier = { kind: 'own', name: selection.name, contact: selection.contact };
      else if (chosen.decision.startsWith('forwarder:')) {
        const party = candidates.find((record) => `forwarder:${record.id}` === chosen.decision)!;
        if (selection?.kind === 'forwarder' && selection.partyId !== party.id) {
          needs.push(assetNeed('party', 'Carrier selection and approval disagree'));
          continue;
        }
        shipment.carrier = { kind: 'forwarder', partyRef: assetRef(party) };
      }
      if (
        shipment.status !== 'draft' &&
        JSON.stringify(before) !== JSON.stringify(shipment.carrier)
      ) {
        shipment.amendments.push({
          field: 'carrier',
          lineId: null,
          before,
          after: structuredClone(shipment.carrier),
          reason: selection!.reason!,
          by: ctx.actor,
          at: ctx.now,
        });
        shipment.chosenQuoteId = null;
        shipment.freight = null;
        shipment.status = shipment.carrier.kind === 'forwarder' ? 'confirmed' : 'booked';
      }
    }
    return stepResult(state, needs);
  },
);
