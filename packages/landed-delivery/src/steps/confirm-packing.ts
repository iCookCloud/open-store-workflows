import { type Need, ProductSlot, getMany, versionHash } from '@osw/core';
import { actionNeed, approval, deliveryStep, inputNeed, stepResult } from '../helpers.js';
import { conflicts, gaps } from '../packing/fill.js';
import { candidatesFor, writeback } from '../verify/writeback.js';

export const confirmPacking = deliveryStep('confirmPacking', ['product'], async (state, ctx) => {
  const needs: Need[] = [];
  for (const shipment of state.plan.shipments) {
    needs.push(
      ...conflicts(shipment).map((reason) => inputNeed(`shipments.${shipment.id}`, reason)),
    );
    for (const line of shipment.lines)
      if (
        !state.plan.compliance.some(
          (entry) =>
            entry.productRef.id === line.productRef?.id &&
            entry.conclusion === 'enter' &&
            entry.tree === 'ok' &&
            !entry.open.mandatory &&
            !entry.orphans.length,
        )
      )
        needs.push(inputNeed(`lines.${line.id}`, 'Line does not have current admission approval'));
    const missing = gaps(shipment);
    if (missing.length)
      needs.push(actionNeed('fillPackingGaps', missing.join(', ').slice(0, 1500), shipment.id));
    if (shipment.carrier.kind === 'unassigned')
      needs.push(inputNeed('carrier', 'Assign a carrier before confirmation'));
    if (shipment.status !== 'draft') continue;
    const hash = await versionHash({
      lines: shipment.lines,
      consignee: shipment.consignee,
      portTo: shipment.portTo,
      carrier: shipment.carrier,
      documents: shipment.documents,
    });
    const decision = approval(
      ctx,
      'confirmPacking',
      `shipment:${shipment.id}`,
      hash,
      ['operator'],
      ['confirm'],
      needs,
    );
    if (decision) shipment.status = shipment.carrier.kind === 'forwarder' ? 'confirmed' : 'booked';
  }
  const products = await getMany(
    ctx.assets,
    ProductSlot,
    state.plan.shipments.flatMap((shipment) =>
      shipment.lines.flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
    ),
  );
  const verified = writeback(
    candidatesFor(
      state.plan.shipments
        .filter((shipment) => shipment.status !== 'draft')
        .flatMap((shipment) => shipment.lines),
    ),
    products,
    ctx,
    'confirmPacking',
  );
  const result = stepResult(state, needs, verified.verifications);
  // 阻断时不能提前回填未定稿的数据。
  result.fills = result.output ? verified.fills : [];
  return result;
});
