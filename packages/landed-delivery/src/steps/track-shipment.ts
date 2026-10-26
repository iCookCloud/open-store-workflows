import { type Need, type Verification, diffDays } from '@osw/core';
import { deliveryStep, inputNeed, numericParam, stepResult, verification } from '../helpers.js';

const nodes = ['depart', 'transit', 'arrived', 'customs', 'final_mile', 'delivered'];
export const trackShipment = deliveryStep('trackShipment', ['params'], async (state, ctx) => {
  const needs: Need[] = [];
  const verifications: Verification[] = [];
  for (const [id, updates] of Object.entries(state.input.updates)) {
    const shipment = state.plan.shipments.find((shipment) => shipment.id === id);
    if (!shipment) {
      needs.push(inputNeed('updates', 'Unknown shipment ID'));
      continue;
    }
    for (const update of updates) {
      if (shipment.status === 'draft' || update.at > ctx.now) {
        needs.push(
          inputNeed('updates', 'Tracking requires confirmed packing and a nonfuture event time'),
        );
        continue;
      }
      if (shipment.status === 'received') {
        if (update.node && update.node !== shipment.node)
          needs.push(inputNeed('updates', 'Received shipment cannot change transport node'));
        continue;
      }
      if (
        update.node &&
        shipment.node &&
        nodes.indexOf(update.node) < nodes.indexOf(shipment.node)
      ) {
        needs.push(inputNeed('updates.node', 'Transport nodes cannot move backwards'));
        continue;
      }
      const tracking = { ...shipment.tracking, ...update.tracking };
      if (update.node === 'depart' && !tracking.departedAt)
        tracking.departedAt = update.at.slice(0, 10);
      if (update.node === 'delivered' && !tracking.deliveredAt)
        tracking.deliveredAt = update.at.slice(0, 10);
      if (
        (tracking.departedAt && tracking.departedAt > ctx.now.slice(0, 10)) ||
        (tracking.deliveredAt && tracking.deliveredAt > ctx.now.slice(0, 10)) ||
        (tracking.departedAt &&
          tracking.deliveredAt &&
          tracking.deliveredAt < tracking.departedAt) ||
        (tracking.etd && tracking.eta && tracking.eta < tracking.etd)
      ) {
        needs.push(inputNeed('updates.tracking', 'Tracking dates are inconsistent'));
        continue;
      }
      if (tracking.deliveredAt && !tracking.departedAt) {
        needs.push(
          inputNeed(
            'updates.tracking.departedAt',
            'A delivery event requires an actual departure date',
          ),
        );
        continue;
      }
      shipment.tracking = tracking;
      if (tracking.deliveredAt) shipment.node = 'delivered';
      else if (update.node) shipment.node = update.node;
      else if (tracking.departedAt && !shipment.node) shipment.node = 'depart';
      if (shipment.node) shipment.status = 'shipped';
      if (update.hold) {
        const affected = shipment.lines.filter((line) => update.hold!.lineIds.includes(line.id));
        if (affected.length !== new Set(update.hold.lineIds).size) {
          needs.push(inputNeed('updates.hold.lineIds', 'Hold references an unknown line'));
          continue;
        }
        const hold = {
          at: update.at,
          reason: update.hold.reason,
          lineIds: [...new Set(update.hold.lineIds)].sort(),
        };
        if (!shipment.holds.some((existing) => JSON.stringify(existing) === JSON.stringify(hold)))
          shipment.holds.push(hold);
        for (const line of affected)
          if (line.productRef) {
            verifications.push(
              verification(
                ctx,
                'trackShipment',
                line.productRef,
                'hsCode',
                'fails',
                update.hold.reason.slice(0, 500),
              ),
            );
            const compliance = state.plan.compliance.find(
              (entry) => entry.productRef.id === line.productRef!.id,
            );
            if (
              update.hold.itemRootId &&
              compliance &&
              !compliance.items.some((item) => item.itemRootId === update.hold!.itemRootId)
            ) {
              const category = state.sources.find(
                (ref) => ref.slot === 'compliance-category' && ref.id === compliance.categoryId,
              );
              if (category)
                verifications.push(
                  verification(
                    ctx,
                    'trackShipment',
                    category,
                    'checklist',
                    'fails',
                    `Unlisted requirement: ${update.hold.itemRootId}`.slice(0, 500),
                  ),
                );
            }
          }
      }
      if (
        update.cleared &&
        !update.hold &&
        ['customs', 'final_mile', 'delivered'].includes(shipment.node ?? '')
      )
        for (const line of shipment.lines)
          if (line.productRef && !shipment.holds.some((hold) => hold.lineIds.includes(line.id)))
            verifications.push(
              verification(
                ctx,
                'trackShipment',
                line.productRef,
                'hsCode',
                'holds',
                'Carrier explicitly reported clearance without a hold',
              ),
            );
    }
    const quote = shipment.quotes.find((quote) => quote.id === shipment.chosenQuoteId);
    if (shipment.tracking.departedAt && shipment.tracking.deliveredAt && quote?.transitDays) {
      const tolerance = numericParam(
        ctx,
        'freight.tolerance.transitDays',
        state.input.jurisdiction,
        needs,
      );
      if (tolerance !== undefined) {
        const actual = diffDays(shipment.tracking.deliveredAt, shipment.tracking.departedAt);
        verifications.push(
          verification(
            ctx,
            'trackShipment',
            quote.partyRef,
            'transitDays',
            actual <= quote.transitDays + tolerance ? 'holds' : 'fails',
            'Actual carrier transit compared with chosen quote',
            {
              field: 'transitDays',
              expected: quote.transitDays,
              actual,
              delta: actual - quote.transitDays,
              unit: 'day',
            },
          ),
        );
      }
    }
  }
  return stepResult(state, needs, verifications);
});
