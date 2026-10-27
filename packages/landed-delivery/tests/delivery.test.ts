import { readFile } from 'node:fs/promises';
import { Need, Verification, slotJsonSchema, versionHash, z } from '@osw/core';
import { executeWorkflow } from '@osw/core/node';
import { describe, expect, it, vi } from 'vitest';
import { DeliveryInput, DeliveryPlan, type DeliveryState, type Shipment } from '../src/models.js';
import { workflow } from '../src/run.js';
import { slots } from '../src/slots.js';
import { collectQuotes } from '../src/steps/collect-quotes.js';
import { recordArrival } from '../src/steps/record-arrival.js';
import { milestone, summarize } from '../src/steps/summarize.js';
import { trackShipment } from '../src/steps/track-shipment.js';
import { approvedDelivery } from './fixtures.js';

describe('quotes, transport and receipt', () => {
  it('rejects quotations addressed to an unknown shipment rather than silently dropping them', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/confirmPacking'].output,
    ) as DeliveryState;
    state.input.quotes.absent = Object.values(state.input.quotes)[0];
    expect((await collectQuotes.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'quotes' }),
    );
  });
  it('rejects mixed currency and an invalid lump sum shape', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/confirmPacking'].output,
    ) as DeliveryState;
    const id = Object.keys(state.input.quotes)[0];
    const quote = state.input.quotes[id][0];
    quote.form = 'itemized';
    quote.items.push({ category: 'other', amount: { amount: 10, currency: 'EUR' } });
    expect((await collectQuotes.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'quotes' }),
    );
    quote.items[1].amount.currency = 'USD';
    quote.form = 'lump_sum';
    expect((await collectQuotes.run(state, fixture.ctx)).output).toBeNull();
  });
  it('cannot choose expired quotes and requires a new decision for changed quotation content', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/confirmPacking'].output,
    ) as DeliveryState;
    const id = Object.keys(state.input.quotes)[0];
    const quote = state.input.quotes[id][0];
    quote.validUntil = '2026-01-01';
    expect((await collectQuotes.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'requestFreightQuote', blocking: true }),
    );
    quote.validUntil = '2026-12-31';
    quote.items[0].amount.amount += 10;
    expect((await collectQuotes.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: `quote:${quote.id}` }),
    );
  });
  it('keeps client acceptance optional and records actual rate deviations', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/confirmPacking'].output as DeliveryState;
    const result = await collectQuotes.run(state, fixture.ctx);
    expect(result.output).not.toBeNull();
    expect(result.verifications).toContainEqual(
      expect.objectContaining({
        dimension: 'rate',
        verdict: 'fails',
        measured: { field: 'rate', expected: 100, actual: 200, delta: 100, unit: 'USD' },
      }),
    );
    const quote = Object.values(state.input.quotes)[0][0];
    fixture.ctx.approvals.push({
      step: 'landed-delivery/collectQuotes',
      subject: `quote:${quote.id}`,
      subjectHash: await versionHash(quote),
      decision: 'accept',
      role: 'client',
      by: 'example:client',
      at: fixture.ctx.now,
    });
    expect((await collectQuotes.run(state, fixture.ctx)).verifications).toContainEqual(
      expect.objectContaining({ dimension: 'clientAcceptance', verdict: 'holds' }),
    );
  });
  it('rejects a draft node, backwards progress and inconsistent delivery dates', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/planShipments'].output,
    ) as DeliveryState;
    const id = state.plan.shipments[0].id;
    state.input.updates = { [id]: [{ node: 'depart', at: '2026-01-05T00:00:00Z' }] };
    expect((await trackShipment.run(state, fixture.ctx)).output).toBeNull();
    state.plan.shipments[0].status = 'booked';
    state.plan.shipments[0].node = 'customs';
    expect((await trackShipment.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'updates.node' }),
    );
    state.input.updates[id] = [
      { node: 'delivered', at: '2026-01-18T00:00:00Z', tracking: { departedAt: '2026-01-19' } },
    ];
    expect((await trackShipment.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'updates.tracking' }),
    );
  });
  it('unifies tracking-only updates with node transitions and keeps delivered distinct from received', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/collectQuotes'].output,
    ) as DeliveryState;
    const id = state.plan.shipments[0].id;
    state.input.updates = {
      [id]: [
        {
          at: '2026-01-18T00:00:00Z',
          tracking: { departedAt: '2026-01-05', deliveredAt: '2026-01-18' },
        },
      ],
    };
    const result = await trackShipment.run(state, fixture.ctx);
    const shipment = result.output!.plan.shipments[0];
    expect(shipment.status).toBe('shipped');
    expect(shipment.node).toBe('delivered');
    expect(shipment.arrival).toBeNull();
  });
  it('records named customs holds, rejects unknown lines and reports missing checklist items', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/collectQuotes'].output,
    ) as DeliveryState;
    const shipment = state.plan.shipments[0];
    state.input.updates = {
      [shipment.id]: [
        {
          node: 'customs',
          at: '2026-01-10T00:00:00Z',
          hold: {
            lineIds: [shipment.lines[0].id],
            reason: 'Synthetic missing document',
            itemRootId: 'missing-document',
          },
        },
      ],
    };
    const result = await trackShipment.run(state, fixture.ctx);
    expect(result.output?.plan.shipments[0].holds).toHaveLength(1);
    expect(result.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'hsCode', verdict: 'fails' }),
    );
    expect(result.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'checklist', verdict: 'fails' }),
    );
    state.input.updates[shipment.id][0].hold!.lineIds = ['absent'];
    expect((await trackShipment.run(state, fixture.ctx)).output).toBeNull();
  });
  it('records measured deltas and refuses receipt replacement or omitted/duplicate lines', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/trackShipment'].output,
    ) as DeliveryState;
    const result = await recordArrival.run(state, fixture.ctx);
    expect(result.verifications).toContainEqual(
      expect.objectContaining({
        dimension: 'carton.grossWeightKg',
        verdict: 'fails',
        measured: { field: 'carton.grossWeightKg', expected: 30, actual: 60, delta: 30 },
      }),
    );
    const id = state.plan.shipments[0].id;
    const resumed = result.output!;
    resumed.input.arrivals[id].by = 'another-signer';
    expect((await recordArrival.run(resumed, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'arrivals' }),
    );
    state.input.arrivals[id].lines = [];
    expect((await recordArrival.run(state, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'arrival.lines' }),
    );
  });
  it('fails explicitly when a measurement tolerance is missing', async () => {
    const fixture = await approvedDelivery();
    const state = fixture.result.steps['landed-delivery/trackShipment'].output as DeliveryState;
    const ctx = { ...fixture.ctx, params: { get: () => undefined } };
    const result = await recordArrival.run(state, ctx);
    expect(result.output).toBeNull();
    expect(result.fills).toEqual([]);
    expect(result.needs).toContainEqual(
      expect.objectContaining({
        kind: 'param',
        key: 'delivery.tolerance.weightPct',
        reason: 'missing',
      }),
    );
  });
});

describe('downstream artifacts and runner contracts', () => {
  it('accepts the actual frozen BOM produced by the fitout example', async () => {
    const bom = JSON.parse(
      await readFile(new URL('../examples/upstream/bom.json', import.meta.url), 'utf8'),
    );
    const input = DeliveryInput.parse({ id: 'example-fitout-delivery', jurisdiction: 'XE', bom });
    expect(input.bom.hash).toBe(await versionHash(input.bom.body));
    expect(input.bom.body.lines[0].sourcing?.partyId).toBe('example-supplier');
    expect(input.bom.body.lines[0].offerRef?.slot).toBe('offer');
  });
  it('does not claim a dated milestone while one required shipment lacks a date', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/recordArrival'].output,
    ) as DeliveryState;
    const equipment = state.plan.shipments.find((shipment) =>
      shipment.lines.some((line) => line.lineKind === 'equipment'),
    )!;
    equipment.arrival = null;
    equipment.tracking = {};
    equipment.status = 'booked';
    const result = await summarize.run(state, fixture.ctx);
    expect(result.output?.body.fitoutGoodsLastAt).toMatchObject({ date: null, basis: 'none' });
    expect(result.output?.body.allReceived).toBe(false);
    expect(result.output?.body.arrivals).toHaveLength(5);
  });
  it('reports the weakest arrival evidence when dates combine estimates and receipts', async () => {
    const fixture = await approvedDelivery();
    const shipments = structuredClone(fixture.result.artifact!.body.shipments) as Shipment[];
    shipments[0].arrival = null;
    shipments[0].tracking = { eta: '2026-01-02' };
    expect(milestone(shipments)).toMatchObject({ date: '2026-01-19', basis: 'eta' });
  });
  it('keeps partial or damaged receipts from reporting allReceived', async () => {
    const fixture = await approvedDelivery();
    const state = structuredClone(
      fixture.result.steps['landed-delivery/recordArrival'].output,
    ) as DeliveryState;
    state.plan.held = [];
    state.plan.shipments[0].arrival!.lines[0].damagedQty = 1;
    expect((await summarize.run(state, fixture.ctx)).output?.body.allReceived).toBe(false);
  });
  it('runs deterministically without asset writes and exposes valid schemas and intents', async () => {
    const fixture = await approvedDelivery();
    const before = JSON.stringify(fixture.input);
    const record = vi.spyOn(fixture.source, 'recordVerification');
    const fill = vi.spyOn(fixture.source, 'applyFills');
    const options = {
      source: fixture.source,
      now: fixture.ctx.now,
      actor: fixture.ctx.actor,
      approvals: fixture.ctx.approvals,
    };
    const first = await executeWorkflow(workflow, fixture.input, options);
    const second = await executeWorkflow(workflow, fixture.input, options);
    expect(first.exitCode).toBe(0);
    expect(first.result).toEqual(second.result);
    expect(JSON.stringify(fixture.input)).toBe(before);
    expect(record).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    DeliveryPlan.parse(first.result.artifact);
    for (const result of Object.values(first.result.steps)) {
      for (const need of result.needs) Need.parse(need);
      for (const verification of result.verifications) Verification.parse(verification);
    }
    for (const slot of slots) expect(slotJsonSchema(slot)).toMatchObject({ type: 'object' });
    for (const step of workflow.steps)
      expect(z.toJSONSchema(step.input, { io: 'input' })).toMatchObject({ type: 'object' });
    expect(first.result.artifact!.sources).toContainEqual(
      expect.objectContaining({ slot: 'params' }),
    );
  });
});
