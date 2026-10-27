import {
  type Need,
  OfferSlot,
  ProductSlot,
  type StepCtx,
  assetRef,
  getMany,
  unitPriceAt,
  versionHash,
} from '@osw/core';
import { assetNeed, inputNeed, refMatches } from './helpers.js';
import type { DeliveryInput, DeliverySourceLine, DeliveryState, Shipment } from './models.js';

export function deliveryLines(state: DeliveryState): DeliverySourceLine[] {
  return state.input.bom?.body.lines ?? state.orderLines ?? [];
}
export const deliveryStoreId = (input: DeliveryInput) => input.bom?.storeId ?? null;
export function shipmentGroup(
  input: DeliveryInput,
  group: Pick<Shipment, 'origin' | 'goodsClass' | 'mode'> & { seller: string | null },
) {
  return { ...group, ...(input.reorder ? { reorderId: input.reorder.id } : {}) };
}
export async function resolveOrderLines(state: DeliveryState, ctx: StepCtx): Promise<Need[]> {
  const order = state.input.reorder;
  if (!order) return [];
  const needs: Need[] = [];
  const at = order.orderedAt ?? ctx.now.slice(0, 10);
  if (at > ctx.now.slice(0, 10))
    return [inputNeed('reorder.orderedAt', 'An order cannot have a future placement date')];
  const offers = await getMany(
    ctx.assets,
    OfferSlot,
    order.lines.map((line) => line.offerRef.id),
  );
  const products = await getMany(
    ctx.assets,
    ProductSlot,
    offers.flatMap((offer) => (offer.data.productId ? [offer.data.productId] : [])),
  );
  const lines: DeliverySourceLine[] = [];
  for (const line of order.lines) {
    const path = `reorder.lines.${line.id}`;
    const offer = offers.find((offer) => offer.id === line.offerRef.id);
    if (!offer || !refMatches(line.offerRef, offer)) {
      needs.push(assetNeed('offer', `${path}: selected offer is missing or changed`));
      continue;
    }
    if (!Array.isArray(offer.data.tiers) || !offer.data.currency || !offer.data.unit) {
      needs.push(assetNeed('offer', `${path}: offer pricing fields are unavailable`));
      continue;
    }
    const product = products.find((product) => product.id === offer.data.productId);
    if (!product || (line.productRef && !refMatches(line.productRef, product))) {
      needs.push(assetNeed('product', `${path}: selected offer must identify the current product`));
      continue;
    }
    if (offer.data.unit !== line.unit) {
      needs.push(
        inputNeed(
          `${path}.unit`,
          'Order and offer units must match before choosing a quantity tier',
        ),
      );
      continue;
    }
    if (
      (offer.data.validFrom && offer.data.validFrom > at) ||
      (offer.data.validUntil && offer.data.validUntil < at) ||
      offer.data.quotedAt > at
    ) {
      needs.push(inputNeed(`${path}.offerRef`, 'Offer was not valid at the order date'));
      continue;
    }
    const unitPrice = unitPriceAt(offer.data, line.qty);
    if (!unitPrice) {
      needs.push(
        inputNeed(
          `${path}.qty`,
          'Order quantity does not meet the offer minimum or any price tier',
        ),
      );
      continue;
    }
    const name =
      product.data.name?.en ?? product.data.name?.[Object.keys(product.data.name).sort()[0]];
    if (!name || product.data.category === undefined) {
      needs.push(assetNeed('product', `${path}: product identity fields are unavailable`));
      continue;
    }
    lines.push({
      ...line,
      productRef: assetRef(product),
      offerRef: assetRef(offer),
      name,
      spec: product.data.spec ?? '',
      category: product.data.category,
      unitPrice,
      ...(order.orderedAt ? { orderedAt: order.orderedAt } : {}),
    });
  }
  state.orderLines = lines;
  if (order.sourceRef) state.sources.push(order.sourceRef);
  for (const shipment of state.plan.shipments) {
    const key = shipmentGroup(state.input, {
      origin: shipment.origin,
      goodsClass: shipment.goodsClass,
      mode: shipment.mode,
      seller: shipment.carrier.kind === 'seller' ? shipment.carrier.partyRef.id : null,
    });
    const prefix = `shipment-${(await versionHash(key)).slice(0, 16)}-`;
    if (!shipment.id.startsWith(prefix))
      needs.push(
        inputNeed(
          'existing.shipments',
          'Existing shipment belongs to a different packing source or order',
        ),
      );
    for (const [field, value] of Object.entries(state.input.consignee ?? {}))
      if (shipment.consignee[field as keyof Shipment['consignee']] !== value)
        needs.push(
          inputNeed(
            'existing.shipments',
            'Warehouse consignee differs; reconcile the destination explicitly',
          ),
        );
  }
  return needs;
}
