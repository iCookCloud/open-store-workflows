import { type Need, ProductSlot, assetRef } from '@osw/core';
import { describe, expect, it } from 'vitest';
import type { DeliveryState, Shipment } from '../src/models.js';
import { conflicts, fillEmptyCells, gaps } from '../src/packing/fill.js';
import { classifyGoods } from '../src/packing/goods-class.js';
import { declarationValue, parseCartonUnits, pieceQuantity } from '../src/packing/units.js';
import { editShipment, viewFor } from '../src/policy.js';
import { assignCarrier } from '../src/steps/assign-carrier.js';
import { confirmPacking } from '../src/steps/confirm-packing.js';
import { planShipments } from '../src/steps/plan-shipments.js';
import { candidatesFor, writeback } from '../src/verify/writeback.js';
import { approvedDelivery, deliveryFixture, rebuild } from './fixtures.js';

describe('packing conversion and grouping', () => {
  it.each(['双头煮面炉', '茶几', 'noodle cooker', 'tea table'])(
    'keeps %s out of food shipments',
    (name) => {
      expect(classifyGoods({}, '', name)).toEqual({ goodsClass: 'nonfood', src: 'derived' });
      expect(classifyGoods({ goodsClass: 'food' }, 'equipment', name)).toEqual({
        goodsClass: 'food',
        src: 'asset',
      });
    },
  );
  it('requires carton information and never converts mass or liquid to pieces', () => {
    expect(parseCartonUnits('12 pcs/carton')).toBe(12);
    expect(parseCartonUnits('每包 100g，20袋/箱')).toBe(20);
    expect(pieceQuantity(3, 'carton', 12)).toBe(36);
    expect(pieceQuantity(3, 'carton')).toBeNull();
    expect(pieceQuantity(3, 'kg')).toBeNull();
    expect(pieceQuantity(3, 'L')).toBeNull();
  });
  it('rejects unverified FX=1 and rounds declaration value at the original selling unit', async () => {
    const { ctx } = await deliveryFixture();
    const needs: Need[] = [];
    const fxCtx = { ...ctx, params: { get: () => ({ value: 1 }) } };
    expect(
      declarationValue({ amount: 100, currency: 'CNY' }, 2, 'USD', 'XE', fxCtx, needs),
    ).toBeNull();
    expect(needs).toContainEqual({
      kind: 'param',
      key: 'fx.CNY.USD',
      reason: 'ambiguous',
      blocking: true,
    });
    expect(declarationValue({ amount: 20.125, currency: 'USD' }, 2, 'USD', 'XE', ctx, [])).toEqual({
      amount: 40.25,
      currency: 'USD',
    });
  });
  it('splits goods classes, urgent air and local seller delivery without duplicate BOM lines', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/planShipments'].output as DeliveryState;
    expect(state.plan.shipments).toHaveLength(4);
    expect(
      state.plan.shipments
        .map((shipment) => [shipment.origin, shipment.goodsClass, shipment.mode])
        .sort(),
    ).toEqual(
      [
        ['XE', 'nonfood', 'ground'],
        ['XF', 'food', 'sea_fcl'],
        ['XF', 'nonfood', 'air'],
        ['XF', 'nonfood', 'sea_fcl'],
      ].sort(),
    );
    const local = state.plan.shipments.find((shipment) => !shipment.crossBorder)!;
    expect(local.carrier.kind).toBe('seller');
    expect(gaps(local)).not.toContain('portTo');
    const before = state.plan.shipments.flatMap((shipment) => shipment.lines).length;
    const repeated = await planShipments.run(state, fixture.ctx);
    expect(repeated.output?.plan.shipments.flatMap((shipment) => shipment.lines)).toHaveLength(
      before,
    );
    expect(
      state.plan.shipments.every((shipment) =>
        shipment.lines.every((line) => line.bomLineId !== 'example-denied'),
      ),
    ).toBe(true);
  });
  it('does not append to confirmed shipments and preserves manually supplied cells', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/planShipments'].output,
    ) as DeliveryState;
    const sea = state.plan.shipments.find(
      (shipment) => shipment.mode === 'sea_fcl' && shipment.goodsClass === 'nonfood',
    )!;
    const moved = sea.lines.pop()!;
    sea.status = 'confirmed';
    const result = await planShipments.run(state, fixture.ctx);
    expect(
      result.output?.plan.shipments.find((shipment) => shipment.id === sea.id)?.lines,
    ).toHaveLength(1);
    expect(
      result.output?.plan.shipments.find(
        (shipment) => shipment.id !== sea.id && shipment.lines.some((line) => line.id === moved.id),
      )?.status,
    ).toBe('draft');
    const manual = structuredClone(sea.lines[0]);
    const fresh = structuredClone(manual);
    manual.netWeightKg = { value: 99, src: 'manual', by: 'operator' };
    fillEmptyCells(manual, fresh);
    expect(manual.netWeightKg.value).toBe(99);
  });
  it('blocks contradictory gross weight while missing cells only produce a gap request', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/assignCarrier'].output,
    ) as DeliveryState;
    const shipment = state.plan.shipments[0];
    shipment.lines[0].totalGrossWeightKg.value = 1;
    expect(conflicts(shipment)).toContainEqual(expect.stringContaining('gross weight'));
    const result = await confirmPacking.run(state, fixture.ctx);
    expect(result.output).toBeNull();
    expect(result.fills).toEqual([]);
    shipment.lines[0].totalGrossWeightKg.value = null;
    expect(conflicts(shipment)).toHaveLength(0);
    expect(gaps(shipment)).toContainEqual(expect.stringContaining('totalGrossWeightKg'));
  });
});

describe('carrier capabilities and collaboration', () => {
  it('requires approval and an amendment for a carrier switch, clears former freight and locks received shipments', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/collectQuotes'].output,
    ) as DeliveryState;
    const shipment = state.plan.shipments.find(
      (shipment) => shipment.carrier.kind === 'forwarder',
    )!;
    state.input.carriers = {
      [shipment.id]: {
        kind: 'own',
        name: 'Example replacement',
        contact: 'carrier@example.com',
        reason: 'Client supplied a carrier',
      },
    };
    const pending = await assignCarrier.run(state, fixture.ctx);
    const need = pending.needs.find((need) => need.kind === 'approval');
    expect(need?.kind).toBe('approval');
    if (need?.kind !== 'approval') throw new Error('Expected a carrier approval');
    fixture.ctx.approvals.push({
      step: need.step,
      subject: need.subject,
      subjectHash: need.subjectHash,
      decision: 'own',
      role: 'operator',
      by: 'example:operator',
      at: fixture.ctx.now,
    });
    const changed = (await assignCarrier.run(state, fixture.ctx)).output!.plan.shipments.find(
      (candidate) => candidate.id === shipment.id,
    )!;
    expect(changed.carrier.kind).toBe('own');
    expect(changed.freight).toBeNull();
    expect(changed.chosenQuoteId).toBeNull();
    expect(changed.amendments.at(-1)?.field).toBe('carrier');
    shipment.status = 'received';
    expect((await assignCarrier.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'carriers' }),
    );
  });
  it('rejects carrier assignments to unknown shipment IDs', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/planShipments'].output,
    ) as DeliveryState;
    state.input.carriers.absent = {
      kind: 'own',
      name: 'Example carrier',
      contact: 'carrier@example.com',
    };
    expect((await assignCarrier.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'carriers' }),
    );
  });
  it('ranks active before standby and rejects split-lane matching', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/planShipments'].output as DeliveryState;
    const matched = await assignCarrier.run(state, fixture.ctx);
    const sea = state.plan.shipments.find((shipment) => shipment.mode === 'sea_fcl')!;
    expect(matched.output?.candidates[sea.id].map((ref) => ref.id)).toEqual([
      'example-forwarder',
      'example-standby',
    ]);
    for (const record of fixture.records.filter((record) => record.data.profiles?.forwarder))
      record.data.profiles.forwarder.lanes = [
        { from: 'XF', to: 'XG', modes: ['sea_fcl'] },
        { from: 'XG', to: 'XE', modes: ['sea_fcl'] },
      ];
    await rebuild(fixture);
    const blocked = await assignCarrier.run(state, fixture.ctx);
    expect(blocked.output).toBeNull();
    expect(blocked.needs).toContainEqual(expect.objectContaining({ kind: 'asset', slot: 'party' }));
  });
  it('excludes carriers lacking cold-chain capability', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/planShipments'].output as DeliveryState;
    for (const record of fixture.records.filter((record) => record.data.profiles?.forwarder))
      record.data.profiles.forwarder.handling = ['liftgate', 'small_vehicle'];
    await rebuild(fixture);
    const result = await assignCarrier.run(state, fixture.ctx);
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', reason: expect.stringContaining('cold_chain') }),
    );
  });
  it('allows carrier fill-only edits, rejects price/name changes and requires amendment reasons', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/confirmPacking'].output as DeliveryState;
    const shipment = structuredClone(
      state.plan.shipments.find((shipment) => shipment.carrier.kind === 'forwarder')!,
    );
    const line = shipment.lines[0];
    for (const field of ['name', 'declaredValue', 'status', '__proto__']) {
      expect(
        editShipment(
          shipment,
          [{ role: 'forwarder', lineId: line.id, field, value: 'changed', reason: 'example' }],
          fixture.ctx,
        ).needs.length,
      ).toBeGreaterThan(0);
    }
    expect(
      editShipment(
        shipment,
        [{ role: 'operator', lineId: line.id, field: 'name', value: 'changed' }],
        fixture.ctx,
      ).needs[0].path,
    ).toBe('edits.reason');
    line.hsCode = { value: null, src: null };
    const edited = editShipment(
      shipment,
      [
        {
          role: 'forwarder',
          lineId: line.id,
          field: 'hsCode',
          value: '000001',
          reason: 'Confirmed by example carrier',
        },
      ],
      fixture.ctx,
    );
    expect(edited.needs).toEqual([]);
    expect(edited.shipment.lines[0].hsCode).toEqual({
      value: '000001',
      src: 'manual',
      by: 'forwarder',
    });
    expect(edited.shipment.amendments).toHaveLength(1);
    expect(
      editShipment(
        edited.shipment,
        [
          {
            role: 'forwarder',
            lineId: line.id,
            field: 'hsCode',
            value: '000002',
            reason: 'overwrite',
          },
        ],
        fixture.ctx,
      ).needs.length,
    ).toBeGreaterThan(0);
  });
  it('hides other quotations and internal amendment/arrival notes from carrier views', async () => {
    const fixture = await approvedDelivery();
    const shipment = fixture.result.artifact!.body.shipments.find(
      (shipment: Shipment) => shipment.carrier.kind === 'forwarder',
    )!;
    shipment.quotes.push({
      ...shipment.quotes[0],
      id: 'another-quote',
      partyRef: { ...shipment.quotes[0].partyRef, id: 'another-forwarder' },
    });
    const view = viewFor(shipment, 'forwarder');
    expect(view.quotes).toHaveLength(1);
    expect(view).not.toHaveProperty('amendments');
    expect(view.arrival?.lines[0]).not.toHaveProperty('note');
  });
});

describe('fill intentions and verification', () => {
  it('never feeds derived values back and rejects conflicting manual observations', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/planShipments'].output as DeliveryState;
    const line = structuredClone(state.plan.shipments[0].lines[0]);
    expect(candidatesFor([line])).toEqual([]);
    line.hsCode = { value: '000 001', src: 'manual', by: 'forwarder' };
    const other = structuredClone(line);
    other.hsCode.value = '000002';
    const product = await fixture.source.get(ProductSlot, line.productRef!.id);
    const result = writeback(
      candidatesFor([line, other]),
      [product!],
      fixture.ctx,
      'confirmPacking',
    );
    expect(result.fills).toEqual([]);
    expect(result.verifications[0]).toMatchObject({
      verdict: 'pending',
      reason: 'conflicting_values',
    });
  });
  it('emits fill only for a truly empty field and fails differences without overwriting', async () => {
    const fixture = await deliveryFixture();
    const product = await fixture.source.get(ProductSlot, 'example-cooker');
    const actual = writeback(
      [{ productId: product!.id, field: 'netWeightKg', value: 99 }],
      [product!],
      fixture.ctx,
      'confirmPacking',
    );
    expect(actual.fills).toEqual([]);
    expect(actual.verifications[0]).toMatchObject({ verdict: 'fails', measured: { delta: 89 } });
    const empty = { ...product!, data: { ...product!.data, customsMaterial: undefined } };
    const filled = writeback(
      [{ productId: empty.id, field: 'customsMaterial', value: 'Example material' }],
      [empty],
      fixture.ctx,
      'confirmPacking',
    );
    expect(filled.fills).toContainEqual(
      expect.objectContaining({
        asset: assetRef(empty),
        field: 'customsMaterial',
        value: 'Example material',
      }),
    );
    empty.redacted = ['customsMaterial'];
    expect(
      writeback(
        [{ productId: empty.id, field: 'customsMaterial', value: 'Example material' }],
        [empty],
        fixture.ctx,
        'confirmPacking',
      ).fills,
    ).toEqual([]);
  });
});
