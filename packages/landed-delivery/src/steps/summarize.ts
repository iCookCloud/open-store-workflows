import { type StepCtx, type StepDef, stepResult, versionHash } from '@osw/core';
import { inputNeed, uniqueRefs } from '../helpers.js';
import { DeliveryPlan, DeliveryState, type Shipment, emptyMilestone } from '../models.js';

export function bestDate(shipment: Shipment) {
  if (shipment.arrival) return { date: shipment.arrival.receivedAt, basis: 'received' as const };
  if (shipment.tracking.deliveredAt)
    return { date: shipment.tracking.deliveredAt, basis: 'delivered' as const };
  if (shipment.tracking.eta) return { date: shipment.tracking.eta, basis: 'eta' as const };
  return { date: null, basis: 'none' as const };
}
export function milestone(shipments: Shipment[], first = false) {
  const shipmentIds = shipments.map((shipment) => shipment.id).sort();
  const dates = shipments.map(bestDate);
  if (!dates.length || dates.some((value) => value.date === null))
    return { ...emptyMilestone(), shipmentIds };
  dates.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  const date = (first ? dates[0] : dates.at(-1)!).date;
  // 汇总里程碑采用所有批次中最弱的证据，避免把仍有 ETA 的集合说成已实收。
  const basis = dates.some((value) => value.basis === 'eta')
    ? 'eta'
    : dates.some((value) => value.basis === 'delivered')
      ? 'delivered'
      : 'received';
  return { date, basis: basis as 'eta' | 'delivered' | 'received', shipmentIds };
}
export const summarize: StepDef<typeof DeliveryState, typeof DeliveryPlan> = {
  id: 'landed-delivery/summarize',
  input: DeliveryState,
  output: DeliveryPlan,
  reads: [],
  params: [],
  async run(raw, ctx: StepCtx) {
    const parsed = DeliveryState.safeParse(raw);
    if (!parsed.success)
      return {
        output: null,
        needs: parsed.error.issues.map((issue) => inputNeed(issue.path.join('.'), issue.message)),
        verifications: [],
      };
    const { input, plan, sources, example } = parsed.data;
    plan.arrivals = plan.shipments.flatMap((shipment) =>
      shipment.lines.map((line) => {
        const received = shipment.arrival?.lines.find((received) => received.lineId === line.id);
        return {
          bomLineId: line.bomLineId,
          shipmentId: shipment.id,
          qty: line.qty,
          basis: bestDate(shipment).basis,
          eta: shipment.tracking.eta ?? null,
          arrivedAt: shipment.arrival?.receivedAt ?? shipment.tracking.deliveredAt ?? null,
          receivedQty: received?.receivedQty ?? null,
          damagedQty: received?.damagedQty ?? null,
        };
      }),
    );
    const fitoutKinds = ['furniture', 'equipment', 'fitout'];
    const fitout = plan.shipments.filter((shipment) =>
      shipment.lines.some((line) => fitoutKinds.includes(line.lineKind)),
    );
    const stock = plan.shipments.filter((shipment) =>
      shipment.lines.some((line) => ['food', 'supplies'].includes(line.lineKind)),
    );
    plan.fitoutGoodsLastAt = milestone(fitout);
    const stages = stock.map((shipment) =>
      shipment.arrival
        ? 3
        : shipment.tracking.deliveredAt
          ? 2
          : shipment.status === 'shipped'
            ? 1
            : 0,
    );
    const status = !stages.length
      ? 'none'
      : (['planned', 'in_transit', 'delivered', 'received'] as const)[Math.min(...stages)];
    plan.openingStock = { status, firstAt: milestone(stock, true), lastAt: milestone(stock) };
    if (
      plan.held.some((held) =>
        input.bom.body.lines.some(
          (line) => line.id === held.bomLineId && fitoutKinds.includes(line.lineKind),
        ),
      )
    )
      plan.fitoutGoodsLastAt = {
        ...emptyMilestone(),
        shipmentIds: fitout.map((shipment) => shipment.id),
      };
    if (
      plan.held.some((held) =>
        input.bom.body.lines.some(
          (line) => line.id === held.bomLineId && ['food', 'supplies'].includes(line.lineKind),
        ),
      )
    )
      plan.openingStock = {
        status: 'planned',
        firstAt: emptyMilestone(),
        lastAt: emptyMilestone(),
      };
    plan.allReceived =
      plan.held.length === 0 &&
      plan.shipments.length > 0 &&
      plan.shipments.every(
        (shipment) =>
          shipment.arrival &&
          shipment.lines.every((line) => {
            const received = shipment.arrival!.lines.find(
              (received) => received.lineId === line.id,
            );
            return received && received.receivedQty >= line.qty && received.damagedQty === 0;
          }),
      );
    const inputs = [
      input.bom,
      ...(input.site ? [input.site] : []),
      ...(input.existing ? [input.existing] : []),
    ].map((artifact) => ({ kind: artifact.kind, id: artifact.id, hash: artifact.hash }));
    return stepResult(
      DeliveryPlan.parse({
        kind: 'DeliveryPlan',
        artifactVersion: '0.1.0',
        id: input.id,
        hash: await versionHash(plan),
        producedBy: {
          step: 'landed-delivery/summarize',
          pkg: '@osw/landed-delivery',
          pkgVersion: '0.1.0',
        },
        storeId: input.bom.storeId,
        inputs,
        sources: uniqueRefs([
          ...sources,
          ...input.bom.sources,
          ...(input.site?.sources ?? []),
          ...(input.existing?.sources ?? []),
        ]),
        createdAt: ctx.now,
        ...(example ? { example: true } : {}),
        body: plan,
      }),
    );
  },
};
