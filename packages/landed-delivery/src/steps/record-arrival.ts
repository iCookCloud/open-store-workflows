import {
  type Need,
  OfferSlot,
  ProductSlot,
  type Verification,
  assetRef,
  diffDays,
  getMany,
  versionHash,
} from '@osw/core';
import { deliveryStep, inputNeed, numericParam, stepResult, verification } from '../helpers.js';
import { type FillCandidate, writeback } from '../verify/writeback.js';

export const recordArrival = deliveryStep(
  'recordArrival',
  ['product', 'offer', 'params'],
  async (state, ctx) => {
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const candidates: FillCandidate[] = [];
    const products = await getMany(
      ctx.assets,
      ProductSlot,
      state.plan.shipments.flatMap((shipment) =>
        shipment.lines.flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
      ),
    );
    const offers = await getMany(
      ctx.assets,
      OfferSlot,
      state.plan.shipments.flatMap((shipment) => shipment.lines.map((line) => line.offerRef.id)),
    );
    for (const [id, arrival] of Object.entries(state.input.arrivals)) {
      const shipment = state.plan.shipments.find((shipment) => shipment.id === id);
      if (!shipment) {
        needs.push(inputNeed('arrivals', 'Unknown shipment ID'));
        continue;
      }
      if (shipment.arrival) {
        if ((await versionHash(shipment.arrival)) !== (await versionHash(arrival)))
          needs.push(
            inputNeed('arrivals', 'An existing signed receipt cannot be silently replaced'),
          );
        continue;
      }
      if (
        shipment.status === 'draft' ||
        !arrival.by.trim() ||
        arrival.receivedAt > ctx.now.slice(0, 10) ||
        (shipment.tracking.departedAt && arrival.receivedAt < shipment.tracking.departedAt) ||
        (shipment.tracking.deliveredAt && arrival.receivedAt < shipment.tracking.deliveredAt)
      ) {
        needs.push(
          inputNeed('arrival', 'Receipt requires confirmed packing, a signer and consistent dates'),
        );
        continue;
      }
      if (
        arrival.lines.length !== shipment.lines.length ||
        new Set(arrival.lines.map((line) => line.lineId)).size !== arrival.lines.length ||
        arrival.lines.some(
          (line) =>
            !shipment.lines.some((packing) => packing.id === line.lineId) ||
            line.damagedQty > line.receivedQty,
        )
      ) {
        needs.push(
          inputNeed(
            'arrival.lines',
            'Record every packing line exactly once; damage cannot exceed received quantity',
          ),
        );
        continue;
      }
      for (const received of arrival.lines) {
        const line = shipment.lines.find((line) => line.id === received.lineId)!;
        const product = products.find((product) => product.id === line.productRef?.id);
        const offer = offers.find((offer) => offer.id === line.offerRef.id);
        if (offer) {
          verifications.push(
            verification(
              ctx,
              'recordArrival',
              assetRef(offer),
              'qty',
              received.receivedQty === line.qty ? 'holds' : 'fails',
              'Actual pieces received compared with packing quantity',
              {
                field: 'qty',
                expected: line.qty,
                actual: received.receivedQty,
                delta: received.receivedQty - line.qty,
              },
              arrival.evidence,
            ),
          );
          if (received.damagedQty > 0)
            verifications.push(
              verification(
                ctx,
                'recordArrival',
                assetRef(offer),
                'damage',
                'fails',
                'Damaged goods reported',
                {
                  field: 'damagedQty',
                  expected: 0,
                  actual: received.damagedQty,
                  delta: received.damagedQty,
                },
                arrival.evidence,
              ),
            );
          const bomLine = state.input.bom.body.lines.find(
            (bomLine) => bomLine.id === line.bomLineId,
          )!;
          if (bomLine.orderedAt && shipment.tracking.departedAt && offer.data.leadTimeDays) {
            const actual = diffDays(shipment.tracking.departedAt, bomLine.orderedAt);
            const expected = offer.data.leadTimeDays.max;
            verifications.push(
              verification(
                ctx,
                'recordArrival',
                assetRef(offer),
                'leadTime',
                actual >= 0 && actual <= expected ? 'holds' : 'fails',
                'Order to departure lead time',
                {
                  field: 'leadTimeDays.max',
                  expected,
                  actual,
                  delta: actual - expected,
                  unit: 'day',
                },
                arrival.evidence,
              ),
            );
          }
        }
        if (!product || !received.cartons) continue;
        const measurements = [
          {
            field: 'carton.units',
            actual: received.receivedQty / received.cartons,
            expected: product.data.carton?.units,
            tolerance: 0,
          },
          ...(received.measuredGrossWeightKg === null
            ? []
            : [
                {
                  field: 'carton.grossWeightKg',
                  actual: received.measuredGrossWeightKg / received.cartons,
                  expected: product.data.carton?.grossWeightKg,
                  tolerance: numericParam(
                    ctx,
                    'delivery.tolerance.weightPct',
                    state.input.jurisdiction,
                    needs,
                  ),
                },
              ]),
          ...(received.measuredVolumeM3 === null
            ? []
            : [
                {
                  field: 'carton.volumeM3',
                  actual: received.measuredVolumeM3 / received.cartons,
                  expected:
                    product.data.carton?.lMm && product.data.carton.wMm && product.data.carton.hMm
                      ? (product.data.carton.lMm *
                          product.data.carton.wMm *
                          product.data.carton.hMm) /
                        1e9
                      : undefined,
                  tolerance: numericParam(
                    ctx,
                    'delivery.tolerance.volumePct',
                    state.input.jurisdiction,
                    needs,
                  ),
                },
              ]),
        ];
        for (const observation of measurements) {
          if (observation.expected === undefined || observation.tolerance === undefined) continue;
          const delta = observation.actual - observation.expected;
          const holds = Math.abs(delta) / observation.expected <= observation.tolerance;
          verifications.push(
            verification(
              ctx,
              'recordArrival',
              assetRef(product),
              observation.field,
              holds ? 'holds' : 'fails',
              'Measured received cartons compared with supplier data',
              {
                field: observation.field,
                expected: observation.expected,
                actual: observation.actual,
                delta,
              },
              arrival.evidence,
            ),
          );
        }
        // 尾箱不满时不能把整批均值当成标准装箱数；只回填精确整数箱规。
        if (
          received.receivedQty > 0 &&
          received.receivedQty % received.cartons === 0 &&
          product.data.carton?.units === undefined
        )
          candidates.push({
            productId: product.id,
            field: 'carton.units',
            value: received.receivedQty / received.cartons,
          });
        if (received.measuredGrossWeightKg && product.data.carton?.grossWeightKg === undefined)
          candidates.push({
            productId: product.id,
            field: 'carton.grossWeightKg',
            value: received.measuredGrossWeightKg / received.cartons,
          });
        if (
          received.measuredVolumeM3 &&
          received.receivedQty > 0 &&
          product.data.unitVolumeM3 === undefined
        )
          candidates.push({
            productId: product.id,
            field: 'unitVolumeM3',
            value: received.measuredVolumeM3 / received.receivedQty,
          });
      }
      const loading = state.input.site?.body.conditions.find(
        (condition) => condition.key === 'loadingAccess',
      );
      if (arrival.observedLoadingAccess !== null && loading && state.input.site) {
        const listing =
          state.input.site.sources.find(
            (source) =>
              source.slot === 'listing' && source.id === state.input.site!.body.listing.id,
          ) ?? state.input.site.body.listing;
        const expected = String(loading.measure.value);
        verifications.push(
          verification(
            ctx,
            'recordArrival',
            listing,
            'loadingAccess',
            expected === arrival.observedLoadingAccess ? 'holds' : 'fails',
            'Observed unloading access compared with site survey',
            { field: 'loadingAccess', expected, actual: arrival.observedLoadingAccess },
            arrival.evidence,
          ),
        );
      }
      shipment.arrival = structuredClone(arrival);
      shipment.status = 'received';
    }
    const verified = writeback(candidates, products, ctx, 'recordArrival');
    const result = stepResult(state, needs, [...verifications, ...verified.verifications]);
    result.fills = result.output ? verified.fills : [];
    return result;
  },
);
