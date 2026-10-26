import {
  type Need,
  type StepDef,
  type Verification,
  assetRef,
  jurisdictionCovers,
  stepResult,
  versionHash,
  z,
} from '@osw/core';
import {
  applicable,
  approval,
  approvalNeed,
  assertUnique,
  inputNeed,
  queryAll,
  uniqueRefs,
  verification,
} from '../helpers.js';
import { BuildOutInput, Takeoff } from '../models.js';
import { buildFeeSlot } from '../slots.js';

export function takeoffSubject(input: BuildOutInput, lines: Takeoff['lines']) {
  return {
    lines: lines.map(({ id, qty }) => ({ id, qty })),
    landlordScope: input.landlordScope,
    changedConditions: input.changedConditions,
  };
}
export const takeoff: StepDef<typeof BuildOutInput, typeof Takeoff> = {
  id: 'build-out/takeoff',
  input: BuildOutInput,
  output: Takeoff,
  reads: ['build-fee'],
  params: [],
  approval: {
    question: 'Confirm measured quantities and landlord scope?',
    decision: z.enum(['confirm']),
  },
  async run(raw, ctx) {
    const parsed = BuildOutInput.safeParse(raw);
    if (!parsed.success)
      return {
        output: null,
        verifications: [],
        needs: parsed.error.issues.map((i) => inputNeed(i.path.join('.'), i.message)),
      };
    const input = parsed.data;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const upstream = [input.bom, input.site, input.delivery];
    if (input.delivery.body.market !== input.site.body.jurisdiction)
      needs.push(
        inputNeed('delivery.market', 'Delivery market must match the selected site jurisdiction'),
      );
    if (new Set(upstream.map((a) => a.storeId)).size !== 1)
      needs.push(inputNeed('storeId', 'All input artifacts must belong to the same store'));
    for (const artifact of upstream)
      if (artifact.hash !== (await versionHash(artifact.body)))
        needs.push(inputNeed(`${artifact.kind}.hash`, 'Artifact body does not match its hash'));
    for (const ref of input.delivery.inputs.filter((ref) => ref.kind === 'Bom'))
      if (ref.id !== input.bom.id || ref.hash !== input.bom.hash)
        needs.push(inputNeed('delivery.inputs', 'Delivery references a different BOM revision'));
    const bomLines = new Map<string, (typeof input.bom.body.lines)[number]>();
    for (const line of input.bom.body.lines) {
      const prior = bomLines.get(line.id);
      if (prior && (await versionHash(prior)) !== (await versionHash(line)))
        needs.push(inputNeed(`bom.lines.${line.id}`, 'Conflicting duplicate BOM line'));
      else bomLines.set(line.id, line);
    }
    const allIds = [...bomLines.keys(), ...input.manualLines.map((l) => l.id)];
    assertUnique(
      input.delivery.body.arrivals.map((a) => `${a.shipmentId}:${a.bomLineId}`),
      'arrival line per shipment',
    );
    for (const arrival of input.delivery.body.arrivals) {
      if (
        arrival.qty < 0 ||
        (arrival.receivedQty !== null && arrival.receivedQty < 0) ||
        (arrival.damagedQty !== null &&
          (arrival.damagedQty < 0 ||
            arrival.receivedQty === null ||
            arrival.damagedQty > arrival.receivedQty))
      )
        needs.push(
          inputNeed(
            `delivery.arrivals.${arrival.bomLineId}`,
            'Receipt and damage quantities must be physically consistent',
          ),
        );
    }
    assertUnique(allIds, 'line id');
    assertUnique(
      input.landlordScope.map((s) => s.item),
      'landlord scope item',
    );
    const landlordWork = input.site.body.lease?.landlordWork ?? [];
    for (const item of landlordWork)
      if (!input.landlordScope.some((s) => s.item === item))
        needs.push(inputNeed('landlordScope', `Map landlord work: ${item}`));
    for (const scope of input.landlordScope)
      if (!landlordWork.includes(scope.item) || scope.lineIds.some((id) => !allIds.includes(id)))
        needs.push(inputNeed('landlordScope', 'Scope must reference lease work and known lines'));
    const excluded = new Set(input.landlordScope.flatMap((s) => s.lineIds));
    for (const id of [
      ...Object.keys(input.quantities),
      ...Object.keys(input.installOverrides),
      ...Object.keys(input.localAvailability),
    ])
      if (!allIds.includes(id)) needs.push(inputNeed(id, 'Unknown line id'));
    const lines: Takeoff['lines'] = [...bomLines.values()]
      .filter((l) => !excluded.has(l.id))
      .map((line) => ({
        id: line.id,
        lineKind: line.lineKind,
        productRef: line.productRef,
        offerRef: line.offerRef,
        qty: input.quantities[line.id] ?? line.qty,
        unit: line.unit,
        source: 'bom',
        bomLineId: line.id,
        bomQty: line.qty,
        name: line.name,
        category: line.category,
        basePrice: { amount: line.unitPrice.amount, currency: line.unitPrice.currency },
        volumePerUnit: line.volumePerUnit,
        installKind: line.installKind,
      }));
    lines.push(
      ...input.manualLines
        .filter((l) => !excluded.has(l.id))
        .map((l) => ({ ...l, source: 'manual' as const, qty: input.quantities[l.id] ?? l.qty })),
    );
    for (const line of lines) {
      const override = input.installOverrides[line.id];
      if (override) {
        line.install = {
          hoursPerUnit: override.hoursPerUnit,
          basis: override.basis,
          overridden: true,
        };
        line.trade = override.trade;
      }
      if (line.basePrice.amount < 0)
        needs.push(inputNeed(`lines.${line.id}.basePrice`, 'Base price cannot be negative'));
      const source = bomLines.get(line.bomLineId ?? '');
      if (source?.derivedFrom.kind === 'case' && line.qty !== source.qty) {
        const refs = input.bom.sources.filter(
          (r) => r.id === source.derivedFrom.ref || r.slot === 'bom-case',
        );
        for (const ref of refs)
          verifications.push(
            verification(
              ctx,
              { ...ref, path: ref.path ?? `/lines/${source.id}` },
              takeoff.id,
              'qty',
              source.qty,
              line.qty,
              false,
              line.unit,
            ),
          );
      }
    }
    const records = (
      await queryAll(ctx, buildFeeSlot, {
        all: [
          { field: 'autoAdd', op: 'eq', value: true },
          jurisdictionCovers('coverage.jurisdictions', input.site.body.jurisdiction),
        ],
      })
    ).filter((r) => applicable(r, input));
    // 运费只复用到店 workflow 的金额，费用规则不能另行估一遍运费。
    const fees: Takeoff['fees'] = records
      .filter((r) => !r.data.freight)
      .map((r) => ({
        id: r.id,
        ...r.data,
        ruleRef: assetRef(r),
        fromDelivery: false,
      }));
    for (const shipment of input.delivery.body.shipments)
      if (shipment.freight)
        fees.push({
          id: `delivery:${shipment.id}`,
          name: 'Delivery freight',
          basis: 'fixed',
          rate: shipment.freight,
          freight: true,
          fromDelivery: true,
        });
    assertUnique(
      fees.map((f) => f.id),
      'fee id',
    );
    const hash = await versionHash(takeoffSubject(input, lines));
    if (approval(ctx, takeoff.id, hash, 'operator')?.decision !== 'confirm')
      needs.push(
        approvalNeed(takeoff.id, hash, 'Confirm quantities, changed conditions and landlord scope'),
      );
    return stepResult(
      Takeoff.parse({
        input,
        lines,
        fees,
        sources: uniqueRefs([
          ...upstream.flatMap((a) => a.sources),
          ...records.filter((r) => !r.data.freight).map((r) => assetRef(r)),
        ]),
        example:
          upstream.every((a) => a.example === true) && records.every((r) => r.example === true),
      }),
      needs,
      verifications,
    );
  },
};
