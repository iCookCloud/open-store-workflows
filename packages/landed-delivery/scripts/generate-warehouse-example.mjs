import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemorySource,
  SHARED_SLOTS,
  assetRef,
  createParamReader,
  fieldsetHash,
  versionHash,
} from '@osw/core';
import { slots, workflow } from '../dist/index.js';

export const NOW = '2026-02-20T12:00:00Z';
export const ACTOR = 'example:warehouse-reviewer';
export const exampleDirectory = fileURLToPath(new URL('../examples/warehouse/', import.meta.url));
const definitions = [...SHARED_SLOTS, ...slots];
export async function warehouseFixture() {
  const records = [];
  const add = async (slot, id, data) => {
    const definition = definitions.find((item) => item.name === slot);
    const record = {
      slot,
      id,
      slotVersion: definition.slotVersion,
      versionHash: await versionHash(data),
      coverage: { tier: 'supply', tracks: [], workflows: ['landed-delivery'], jurisdictions: [] },
      updatedAt: '2026-02-01T00:00:00Z',
      example: true,
      data,
    };
    if (definition.fieldsets)
      record.fieldsetHashes = Object.fromEntries(
        await Promise.all(
          Object.entries(definition.fieldsets).map(async ([key, fields]) => [
            key,
            await fieldsetHash(data, fields),
          ]),
        ),
      );
    records.push(record);
    return record;
  };
  const supplier = await add('party', 'example-overseas-supplier', {
    name: { en: 'Example Overseas Supplier' },
    roles: ['supplier'],
    status: 'active',
    base: { jurisdiction: 'XF' },
  });
  const carrier = await add('party', 'example-warehouse-carrier', {
    name: { en: 'Example Warehouse Carrier' },
    roles: ['forwarder'],
    status: 'active',
    profiles: {
      forwarder: {
        rank: 10,
        goodsClasses: ['food', 'nonfood'],
        lanes: [{ from: 'XF', to: 'XE', modes: ['sea_lcl'] }],
        handling: [],
      },
    },
  });
  await add('compliance-category', 'example-warehouse-category', {
    parentId: null,
    market: 'XE',
    name: 'Invented warehouse import category',
    goneAt: null,
  });
  await add('compliance-item', 'example-warehouse-item', {
    categoryId: 'example-warehouse-category',
    market: 'XE',
    name: 'Invented SKU evidence',
    level: 'sku',
    entityRole: null,
    required: 'mandatory',
    issuer: 'Example issuer',
    officialUrl: 'https://example.com/warehouse-check',
    evidenceHint: 'Synthetic evidence only',
    certTag: null,
    overrideOf: null,
    retired: false,
  });
  const lines = [];
  // 从零构造两种计价口径，按箱报价与按件报价共用 core LineItem。
  for (const [id, lineKind, qty, unit, units, grossWeight, currency, tiers] of [
    [
      'example-rice',
      'food',
      2,
      'carton',
      10,
      110,
      'EUR',
      [
        { minQty: 1, unitPrice: 100 },
        { minQty: 2, unitPrice: 80 },
      ],
    ],
    ['example-supply', 'supplies', 12, 'pcs', 6, 70, 'USD', [{ minQty: 10, unitPrice: 10 }]],
  ]) {
    const product = await add('product', id, {
      name: { en: `Example ${lineKind}` },
      kind: 'catalog',
      category: lineKind,
      goodsClass: lineKind === 'food' ? 'food' : 'nonfood',
      status: 'active',
      spec: `${units} pcs/carton`,
      netWeightKg: 10,
      carton: { units, grossWeightKg: grossWeight, lMm: 1000, wMm: 1000, hMm: 1000 },
      hsCode: '000000',
      customsMaterial: 'Example material',
      storage: 'ambient',
    });
    const offer = await add('offer', `${id}-offer`, {
      partyId: supplier.id,
      productId: product.id,
      basis: 'quote',
      use: 'repeat',
      currency,
      unit,
      tiers,
      moq: tiers[0].minQty,
      quotedAt: '2026-02-01',
      validUntil: '2026-12-31',
      shipFrom: 'XF',
      delivery: 'buyer_arranges',
      leadTimeDays: { min: 1, max: 5 },
    });
    await add('product-classification', `${id}-classification`, {
      productId: id,
      market: 'XE',
      categoryId: 'example-warehouse-category',
      by: 'example:classifier',
      at: '2026-02-01T00:00:00Z',
    });
    await add('compliance-answer', `${id}-answer`, {
      market: 'XE',
      itemRootId: 'example-warehouse-item',
      subject: { kind: 'product', id },
      state: 'cited',
      evidence: [`https://example.com/warehouse-evidence/${id}`],
      validUntil: '2026-12-31',
      by: 'example:reviewer',
      at: '2026-02-01T00:00:00Z',
    });
    lines.push({ id: `${id}-line`, lineKind, offerRef: assetRef(offer), qty, unit });
  }
  for (const [key, value] of [
    ['customs.declarationCurrency', 'USD'],
    ['fx.EUR.USD', 2],
    ['delivery.tolerance.weightPct', 0.1],
    ['delivery.tolerance.volumePct', 0.1],
    ['freight.tolerance.transitDays', 1],
  ])
    await add('params', `example-${key}`, { key, value });
  const input = {
    id: 'example-warehouse-delivery',
    jurisdiction: 'XE',
    reorder: {
      id: 'example-warehouse-order',
      lines,
      mode: 'sea_lcl',
      orderedAt: '2026-02-01',
      loadingAccess: {
        value: 'dock',
        basis: 'observed',
        at: '2026-02-01T00:00:00Z',
        by: 'example:receiver',
      },
      example: true,
    },
    consignee: {
      jurisdiction: 'XE',
      company: 'Example Warehouse',
      address: 'Example Warehouse Road, Example City',
      name: 'Example Receiving Team',
      phone: 'EXAMPLE',
      email: 'warehouse@example.com',
    },
    expectedArrival: '2026-02-20',
    portTo: 'Example Destination Port',
    carriers: {},
    edits: {},
    quotes: {},
    updates: {},
    arrivals: {},
  };
  const source = new MemorySource(records, definitions);
  const ctx = {
    assets: source,
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      NOW,
      { jurisdiction: 'XE' },
    ),
    approvals: [],
    providers: {},
    now: NOW,
    actor: ACTOR,
  };
  return { records, input, source, ctx, carrier };
}
export async function approvedWarehouse() {
  const fixture = await warehouseFixture();
  const { input, ctx, carrier } = fixture;
  let configured = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await workflow.run(input, ctx);
    if (result.artifact) return { ...fixture, result };
    const planned = result.steps['landed-delivery/planShipments']?.output;
    if (planned && !configured) {
      for (const shipment of planned.plan.shipments) {
        input.quotes[shipment.id] = [
          {
            id: `${shipment.id}-quote`,
            partyRef: assetRef(carrier),
            form: 'lump_sum',
            items: [{ category: 'other', amount: { amount: 100, currency: 'USD' } }],
            terms: 'Synthetic warehouse quotation',
            transitDays: 10,
            validUntil: '2026-12-31',
            receivedAt: '2026-02-02T00:00:00Z',
          },
        ];
        input.updates[shipment.id] = [
          { node: 'depart', at: '2026-02-05T00:00:00Z' },
          { node: 'delivered', at: '2026-02-18T00:00:00Z', cleared: true },
        ];
        input.arrivals[shipment.id] = {
          receivedAt: '2026-02-19',
          by: 'example:warehouse-receiver',
          evidence: ['https://example.com/warehouse-receipt'],
          observedLoadingAccess: 'dock',
          lines: shipment.lines.map((line) => ({
            lineId: line.id,
            receivedQty: line.qty,
            damagedQty: 0,
            cartons: line.cartons.value,
            measuredGrossWeightKg: line.totalGrossWeightKg.value,
            measuredVolumeM3: line.totalVolumeM3.value,
            note: 'Synthetic complete warehouse receipt',
          })),
        };
      }
      configured = true;
    }
    const needs = result.needs.filter((need) => need.blocking);
    if (needs.some((need) => need.kind !== 'approval'))
      throw new Error(`Warehouse example blocked: ${JSON.stringify(needs)}`);
    for (const need of needs) {
      const step = need.step.split('/')[1];
      const decisions = {
        screenCompliance: 'enter',
        assignCarrier: `forwarder:${carrier.id}`,
        confirmPacking: 'confirm',
        collectQuotes: 'choose',
      };
      if (!decisions[step]) throw new Error(`Unexpected example gate ${step}`);
      ctx.approvals.push({
        step: need.step,
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision: decisions[step],
        role: step === 'screenCompliance' ? 'reviewer' : 'operator',
        by: 'example:approver',
        at: NOW,
      });
    }
  }
  throw new Error('Warehouse approvals did not converge');
}
export async function generateWarehouseExample(directory = exampleDirectory) {
  const fixture = await approvedWarehouse();
  const write = async (path, value) => {
    const target = resolve(directory, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const name of new Set(fixture.records.map((record) => record.slot)))
    await write(`assets/${name}.json`, {
      $example: 'synthetic',
      items: fixture.records.filter((record) => record.slot === name),
    });
  await write('input.json', fixture.input);
  await write('approvals.json', fixture.ctx.approvals);
  await write('expected.json', fixture.result.artifact);
  return fixture;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateWarehouseExample();
