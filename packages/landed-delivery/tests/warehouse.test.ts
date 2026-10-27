import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LineItem, MemorySource, SHARED_SLOTS, createParamReader, versionHash } from '@osw/core';
import { executeWorkflow, runCli } from '@osw/core/node';
import { describe, expect, it, vi } from 'vitest';
import { approvedWarehouse, warehouseFixture } from '../scripts/generate-warehouse-example.mjs';
import { DeliveryInput, DeliveryPlan, type DeliveryState } from '../src/models.js';
import { workflow } from '../src/run.js';
import { slots } from '../src/slots.js';
import { planShipments } from '../src/steps/plan-shipments.js';
import { screenCompliance } from '../src/steps/screen-compliance.js';

async function changeOffer(
  fixture: Awaited<ReturnType<typeof warehouseFixture>>,
  update: (data: any) => void,
  repin = true,
) {
  const line = fixture.input.reorder.lines[0];
  const record = fixture.records.find((record) => record.id === line.offerRef.id)!;
  update(record.data);
  record.versionHash = await versionHash(record.data);
  fixture.source.add(record);
  if (repin) line.offerRef.versionHash = record.versionHash;
}
describe('warehouse order input', () => {
  it('reports a need when offer prices are hidden instead of computing a fallback', async () => {
    const fixture = await warehouseFixture();
    const record = fixture.records.find(
      (record) => record.id === fixture.input.reorder.lines[0].offerRef.id,
    )!;
    fixture.source.add({
      ...record,
      redacted: ['tiers'],
      data: { ...record.data, tiers: undefined },
    });
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.output).toBeNull();
    expect(result.needs).toContainEqual(
      expect.objectContaining({
        kind: 'asset',
        slot: 'offer',
        reason: expect.stringContaining('pricing fields are unavailable'),
      }),
    );
  });
  it('accepts only core LineItem data and requires one unambiguous packing source', async () => {
    const fixture = await warehouseFixture();
    expect(fixture.input.reorder.lines.map((line) => LineItem.parse(line))).toEqual(
      fixture.input.reorder.lines,
    );
    const parsed = DeliveryInput.parse(fixture.input);
    expect(parsed.bom).toBeUndefined();
    const bom = JSON.parse(
      await readFile(
        new URL('../examples/bom/inputs/landed-delivery.json', import.meta.url),
        'utf8',
      ),
    ).bom;
    expect(DeliveryInput.safeParse({ ...fixture.input, bom }).success).toBe(false);
    expect(DeliveryInput.safeParse({ ...fixture.input, reorder: undefined }).success).toBe(false);
  });
  it.each(['company', 'address', 'name', 'phone', 'jurisdiction'])(
    'requires the warehouse %s',
    async (field) => {
      const fixture = await warehouseFixture();
      const result = await screenCompliance.run(
        { ...fixture.input, consignee: { ...fixture.input.consignee, [field]: ' ' } },
        fixture.ctx,
      );
      expect(result.output).toBeNull();
      expect(result.needs).toContainEqual(
        expect.objectContaining({ kind: 'input', path: `consignee.${field}` }),
      );
    },
  );
  it('rejects destination mismatch, duplicate line IDs, missing offers and missing mode', async () => {
    const { input } = await warehouseFixture();
    expect(
      DeliveryInput.safeParse({ ...input, consignee: { ...input.consignee, jurisdiction: 'XF' } })
        .success,
    ).toBe(false);
    expect(
      DeliveryInput.safeParse({
        ...input,
        reorder: { ...input.reorder, lines: [input.reorder.lines[0], input.reorder.lines[0]] },
      }).success,
    ).toBe(false);
    expect(
      DeliveryInput.safeParse({
        ...input,
        reorder: { ...input.reorder, lines: [{ ...input.reorder.lines[0], offerRef: undefined }] },
      }).success,
    ).toBe(false);
    expect(
      DeliveryInput.safeParse({ ...input, reorder: { ...input.reorder, mode: undefined } }).success,
    ).toBe(false);
  });
  it('blocks missing, stale and mismatched product/offer selections', async () => {
    const fixture = await warehouseFixture();
    await changeOffer(
      fixture,
      (data) => {
        data.tiers[1].unitPrice = 90;
      },
      false,
    );
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'offer' }),
    );
    const missing = structuredClone(fixture.input);
    missing.reorder.lines[0].offerRef.id = 'absent';
    expect((await screenCompliance.run(missing, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'offer' }),
    );
    const wrong = await warehouseFixture();
    const other = wrong.records.find(
      (record) => record.slot === 'product' && record.id === 'example-supply',
    )!;
    wrong.input.reorder.lines[0].productRef = {
      slot: 'product',
      id: other.id,
      versionHash: other.versionHash,
    };
    expect((await screenCompliance.run(wrong.input, wrong.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'product' }),
    );
  });
  it('refuses unsupported pricing units, unmet minimums and expired quotations', async () => {
    const fixture = await warehouseFixture();
    fixture.input.reorder.lines[0].unit = 'pcs';
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'reorder.lines.example-rice-line.unit' }),
    );
    fixture.input.reorder.lines[0].unit = 'carton';
    await changeOffer(fixture, (data) => {
      data.moq = 3;
    });
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'reorder.lines.example-rice-line.qty' }),
    );
    await changeOffer(fixture, (data) => {
      data.moq = 1;
      data.validUntil = '2026-01-31';
    });
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'reorder.lines.example-rice-line.offerRef' }),
    );
  });
  it('reads product identity and tier price from the selected offer rather than order-only extra fields', async () => {
    const fixture = await approvedWarehouse();
    const input = structuredClone(fixture.input);
    Object.assign(input.reorder.lines[0], {
      unitPrice: { amount: 1, currency: 'USD' },
      name: 'Untrusted name',
    });
    const screened = await screenCompliance.run(input, fixture.ctx);
    expect(screened.output?.orderLines?.[0]).toMatchObject({
      name: 'Example food',
      unitPrice: { amount: 80, currency: 'EUR' },
    });
    const state = screened.output!;
    state.orderLines![0].unitPrice.amount = 1;
    const planned = await planShipments.run(state, fixture.ctx);
    expect(
      planned.output?.plan.shipments
        .flatMap((shipment) => shipment.lines)
        .find((line) => line.bomLineId === 'example-rice-line')?.declaredValue,
    ).toEqual({ amount: 320, currency: 'USD' });
  });
});

describe('warehouse delivery lifecycle', () => {
  it('runs from overseas order to warehouse receipt without a store asset or fabricated BOM', async () => {
    const fixture = await approvedWarehouse();
    const query = vi.spyOn(fixture.source, 'query');
    const record = vi.spyOn(fixture.source, 'recordVerification');
    const fill = vi.spyOn(fixture.source, 'applyFills');
    const before = JSON.stringify(fixture.input);
    const result = await executeWorkflow(workflow, fixture.input, {
      source: fixture.source,
      now: fixture.ctx.now,
      actor: fixture.ctx.actor,
      approvals: fixture.ctx.approvals,
    });
    expect(result.exitCode).toBe(0);
    const artifact = DeliveryPlan.parse(result.result.artifact);
    expect(artifact.storeId).toBeNull();
    expect(artifact.inputs).toEqual([]);
    expect(artifact.body.shipments).toHaveLength(2);
    expect(artifact.body.allReceived).toBe(true);
    expect(
      artifact.body.shipments.every(
        (shipment) =>
          shipment.status === 'received' &&
          shipment.crossBorder &&
          shipment.mode === 'sea_lcl' &&
          shipment.consignee.company === 'Example Warehouse',
      ),
    ).toBe(true);
    expect(artifact.body.arrivals.map((line) => line.receivedQty).sort((a, b) => a! - b!)).toEqual([
      12, 20,
    ]);
    expect(
      artifact.body.shipments
        .flatMap((shipment) => shipment.lines)
        .map((line) => line.declaredValue.amount)
        .sort((a, b) => a - b),
    ).toEqual([120, 320]);
    expect(query.mock.calls.some(([slot]) => slot.name === 'store')).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.input)).toBe(before);
  });
  it('still requires admission and packing approvals, and invalidates confirmation when the warehouse changes', async () => {
    const fixture = await approvedWarehouse();
    const blocked = await workflow.run(fixture.input, { ...fixture.ctx, approvals: [] });
    expect(blocked.artifact).toBeNull();
    expect(blocked.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', step: 'landed-delivery/screenCompliance' }),
    );
    fixture.input.consignee.address = 'Another Example Warehouse Road';
    const changed = await workflow.run(fixture.input, fixture.ctx);
    expect(changed.artifact).toBeNull();
    expect(changed.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', step: 'landed-delivery/confirmPacking' }),
    );
  });
  it('fails closed when declaration FX is missing', async () => {
    const fixture = await approvedWarehouse();
    const records = fixture.records.filter((record) => record.data.key !== 'fx.EUR.USD');
    const ctx = {
      ...fixture.ctx,
      assets: new MemorySource(records, [...SHARED_SLOTS, ...slots]),
      params: createParamReader(
        records.filter((record) => record.slot === 'params'),
        fixture.ctx.now,
        { jurisdiction: 'XE' },
      ),
    };
    const result = await workflow.run(fixture.input, ctx);
    expect(result.artifact).toBeNull();
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'param', key: 'fx.EUR.USD' }),
    );
  });
  it('resumes receipts without duplicate packing and rejects a changed order, quantity or destination', async () => {
    const fixture = await approvedWarehouse();
    const resumed = {
      ...fixture.input,
      existing: fixture.result.artifact,
      updates: {},
      arrivals: {},
      quotes: {},
    };
    const same = await workflow.run(resumed, fixture.ctx);
    expect(same.artifact?.body.arrivals).toHaveLength(2);
    expect(same.artifact?.body.allReceived).toBe(true);
    for (const mutate of [
      (input: typeof resumed) => {
        input.reorder.id = 'another-order';
      },
      (input: typeof resumed) => {
        input.consignee.address = 'Another warehouse';
      },
      (input: typeof resumed) => {
        input.reorder.lines[0].qty = 3;
      },
    ]) {
      const input = structuredClone(resumed);
      mutate(input);
      const result = await workflow.run(input, fixture.ctx);
      expect(result.artifact).toBeNull();
      expect(result.needs).toContainEqual(
        expect.objectContaining({ kind: 'input', path: 'existing.shipments' }),
      );
    }
  });
  it('uses the shared CLI runner for the packaged warehouse example and its approval gate', async () => {
    const fixture = await approvedWarehouse();
    const base = fileURLToPath(new URL('../.osw/', import.meta.url));
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(`${base}warehouse-cli-`);
    await writeFile(`${cwd}/input.json`, JSON.stringify(fixture.input));
    await writeFile(`${cwd}/approvals.json`, JSON.stringify(fixture.ctx.approvals));
    const args = [
      'landed-delivery',
      'run',
      '--in',
      'input.json',
      '--now',
      fixture.ctx.now,
      '--actor',
      fixture.ctx.actor,
      '--out-dir',
      'result',
    ];
    const options = { cwd, workflows: [workflow], source: fixture.source, stdout: () => {} };
    expect(await runCli(args, options)).toBe(2);
    expect(await runCli([...args, '--approvals', 'approvals.json'], options)).toBe(0);
    expect(JSON.parse(await readFile(`${cwd}/result/artifact.json`, 'utf8'))).toEqual(
      fixture.result.artifact,
    );
  });
});
