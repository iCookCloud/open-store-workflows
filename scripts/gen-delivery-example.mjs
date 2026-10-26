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
import { slots, workflow } from '@osw/landed-delivery';

export const DELIVERY_NOW = '2026-01-20T12:00:00Z';
export const DELIVERY_ACTOR = 'example:delivery-reviewer';
export const deliveryDirectory = fileURLToPath(
  new URL('../examples/sample-delivery/', import.meta.url),
);
const allSlots = [...SHARED_SLOTS, ...slots];
const usd = (amount) => ({ amount, currency: 'USD' });
export async function deliveryFixture() {
  const records = [];
  const add = async (slot, id, data) => {
    const definition = allSlots.find((definition) => definition.name === slot);
    const record = {
      slot,
      id,
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      coverage: { tier: 'supply', tracks: [], workflows: ['landed-delivery'], jurisdictions: [] },
      updatedAt: '2026-01-01T00:00:00Z',
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
  await add('store', 'example-delivery-store', {
    name: { en: 'Example Delivery Store' },
    status: 'preparing',
    track: 'example-noodle',
    jurisdiction: 'XE',
    timezone: 'UTC',
    address: { line1: 'Example Street', locality: 'Example City', jurisdiction: 'XE' },
  });
  const supplier = await add('party', 'example-supplier', {
    name: { en: 'Example Supplier' },
    roles: ['supplier'],
    status: 'active',
    base: { jurisdiction: 'XF' },
  });
  const local = await add('party', 'example-local-seller', {
    name: { en: 'Example Local Seller' },
    roles: ['supplier'],
    status: 'active',
    base: { jurisdiction: 'XE' },
  });
  const forwarder = await add('party', 'example-forwarder', {
    name: { en: 'Example Forwarder' },
    roles: ['forwarder'],
    status: 'active',
    profiles: {
      forwarder: {
        rank: 10,
        goodsClasses: ['food', 'nonfood'],
        lanes: [{ from: 'XF', to: 'XE', modes: ['sea_fcl', 'sea_lcl', 'air'] }],
        handling: ['cold_chain', 'frozen', 'liftgate', 'small_vehicle'],
      },
    },
  });
  await add('party', 'example-standby', {
    ...forwarder.data,
    name: { en: 'Example Standby' },
    status: 'standby',
    profiles: { forwarder: { ...forwarder.data.profiles.forwarder, rank: 0 } },
  });
  await add('compliance-category', 'example-category', {
    parentId: null,
    market: 'XE',
    name: 'Example synthetic category',
    goneAt: null,
  });
  const item = {
    categoryId: 'example-category',
    market: 'XE',
    name: 'Invented sample checklist item',
    level: 'sku',
    entityRole: null,
    required: 'mandatory',
    issuer: 'Example authority',
    officialUrl: 'https://example.com/checklist',
    evidenceHint: 'Synthetic evidence only',
    certTag: null,
    overrideOf: null,
    retired: false,
  };
  await add('compliance-item', 'example-certificate', item);
  await add('compliance-item', 'example-batch-document', {
    ...item,
    name: 'Invented batch document',
    level: 'batch',
  });
  const lines = [];
  for (const [id, lineKind, name, origin, urgent, denied] of [
    ['example-cooker', 'equipment', '双头煮面炉', 'XF', false, false],
    ['example-table', 'furniture', '茶几', 'XF', false, false],
    ['example-food', 'food', 'Example noodles', 'XF', false, false],
    ['example-urgent', 'equipment', 'Example urgent equipment', 'XF', true, false],
    ['example-local', 'supplies', 'Example local supplies', 'XE', false, false],
    ['example-denied', 'food', 'Example denied product', 'XF', false, true],
  ]) {
    const product = await add('product', id, {
      name: { en: name },
      kind: 'catalog',
      category: lineKind,
      goodsClass: lineKind === 'food' ? 'food' : 'nonfood',
      status: 'active',
      spec: '2 pcs/carton',
      netWeightKg: 10,
      unitVolumeM3: 0.1,
      carton: { units: 2, grossWeightKg: 30, lMm: 1000, wMm: 1000, hMm: 1000 },
      hsCode: '000000',
      customsMaterial: 'Example synthetic material',
      storage: lineKind === 'food' ? 'chilled' : 'ambient',
    });
    const party = origin === 'XE' ? local : supplier;
    const offer = await add('offer', `${id}-offer`, {
      partyId: party.id,
      productId: id,
      basis: 'quote',
      use: 'project',
      currency: 'USD',
      unit: 'pcs',
      tiers: [{ minQty: 1, unitPrice: 100 }],
      quotedAt: '2026-01-01',
      shipFrom: origin,
      delivery: origin === 'XE' ? 'seller_delivers' : 'buyer_arranges',
      leadTimeDays: { min: 1, max: 10 },
    });
    await add('product-classification', `${id}-classification`, {
      productId: id,
      market: 'XE',
      categoryId: 'example-category',
      by: 'example:classifier',
      at: '2026-01-01T00:00:00Z',
    });
    await add('compliance-answer', `${id}-answer`, {
      market: 'XE',
      itemRootId: 'example-certificate',
      subject: { kind: 'product', id },
      state: 'cited',
      evidence: [`https://example.com/evidence/${id}`],
      validUntil: '2026-12-31',
      by: 'example:reviewer',
      at: '2026-01-01T00:00:00Z',
    });
    lines.push({
      id,
      lineKind,
      productRef: assetRef(product),
      offerRef: assetRef(offer),
      qty: 2,
      unit: 'pcs',
      category: lineKind,
      name,
      zone: 'example',
      spec: '2 pcs/carton',
      qtyRule: { kind: 'manual' },
      qtyBasis: { status: 'manual', note: 'Invented constant' },
      dimsBasis: { status: 'manual', note: 'Invented constant' },
      budgetKey:
        lineKind === 'furniture'
          ? 'furnishing'
          : lineKind === 'food' || lineKind === 'supplies'
            ? 'opening_inventory'
            : 'equipment',
      evidence: [],
      derivedFrom: { kind: 'manual', ref: 'example' },
      pricingMode: 'whole',
      components: [],
      modelCostPerUnit: null,
      parts: [],
      modelWarnings: [],
      sourcing: {
        partyId: party.id,
        offerPrice: usd(100),
        tierMinQty: 1,
        includes: [],
        quotedAt: '2026-01-01',
        leadTimeDays: { min: 1, max: 10 },
      },
      costBasis: 'offer',
      unitPrice: { ...usd(100), basis: 'quote' },
      urgent,
      orderedAt: '2026-01-01',
    });
  }
  for (const goodsClass of ['food', 'nonfood'])
    await add('rate-card', `example-rate-${goodsClass}`, {
      partyId: forwarder.id,
      from: 'XF',
      to: 'XE',
      mode: 'sea_fcl',
      goodsClass,
      basis: 'shipment',
      rate: usd(100),
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
    });
  for (const [key, value] of [
    ['customs.declarationCurrency', 'USD'],
    ['delivery.tolerance.weightPct', 0.1],
    ['delivery.tolerance.volumePct', 0.1],
    ['freight.tolerance.rateCardPct', 0.1],
    ['freight.tolerance.transitDays', 1],
  ])
    await add('params', `example-${key}`, { key, value });
  const body = {
    currency: 'USD',
    lines,
    totals: { model: usd(0), chosen: usd(1200), byBudgetKey: {} },
  };
  const bom = {
    kind: 'Bom',
    artifactVersion: '0.1.0',
    id: 'example-bom',
    hash: await versionHash(body),
    producedBy: { step: 'fitout-bom/assembleBom', pkg: '@osw/fitout-bom', pkgVersion: '0.1.0' },
    storeId: 'example-delivery-store',
    inputs: [],
    sources: records
      .filter((record) => ['product', 'offer'].includes(record.slot))
      .map((record) => assetRef(record)),
    createdAt: '2026-01-01T00:00:00Z',
    example: true,
    body,
  };
  const input = {
    id: 'example-delivery',
    jurisdiction: 'XE',
    bom,
    expectedArrival: '2026-01-20',
    consignee: {
      jurisdiction: 'XE',
      company: 'Example Company',
      address: 'Example Street',
      name: 'Example Receiver',
      phone: 'EXAMPLE',
      email: 'receiver@example.com',
    },
    portTo: 'Example Port',
    carriers: {},
    edits: {},
    quotes: {},
    updates: {},
    arrivals: {},
  };
  const source = new MemorySource(records, allSlots);
  const ctx = {
    assets: source,
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      DELIVERY_NOW,
      { jurisdiction: 'XE' },
    ),
    approvals: [],
    providers: {},
    now: DELIVERY_NOW,
    actor: DELIVERY_ACTOR,
  };
  return { records, input, source, ctx, forwarder };
}
export async function approvedDelivery() {
  const fixture = await deliveryFixture();
  const { input, ctx, forwarder } = fixture;
  let configured = false;
  for (let turn = 0; turn < 12; turn++) {
    const result = await workflow.run(input, ctx);
    if (result.artifact) return { ...fixture, result };
    const planned = result.steps['landed-delivery/planShipments']?.output;
    if (planned && !configured) {
      for (const shipment of planned.plan.shipments) {
        if (shipment.mode === 'air')
          input.carriers[shipment.id] = {
            kind: 'own',
            name: 'Example Own Carrier',
            contact: 'carrier@example.com',
          };
        if (shipment.mode.startsWith('sea'))
          input.quotes[shipment.id] = [
            {
              id: `${shipment.id}-quote`,
              partyRef: assetRef(forwarder),
              form: 'lump_sum',
              items: [{ category: 'other', amount: usd(200) }],
              terms: 'Synthetic example only',
              transitDays: 10,
              validUntil: '2026-12-31',
              receivedAt: '2026-01-02T00:00:00Z',
            },
          ];
        input.updates[shipment.id] = [
          { node: 'depart', at: '2026-01-05T00:00:00Z', tracking: { eta: '2026-01-15' } },
          { node: 'delivered', at: '2026-01-18T00:00:00Z', cleared: true },
        ];
        input.arrivals[shipment.id] = {
          receivedAt: '2026-01-19',
          by: 'example:receiver',
          evidence: ['https://example.com/receipt'],
          observedLoadingAccess: null,
          lines: shipment.lines.map((line) => ({
            lineId: line.id,
            receivedQty: line.qty,
            damagedQty: 0,
            cartons: 1,
            measuredGrossWeightKg: 60,
            measuredVolumeM3: 2,
            note: 'Invented discrepancy to exercise verification',
          })),
        };
      }
      configured = true;
      continue;
    }
    const blocking = result.needs.filter((need) => need.blocking);
    if (blocking.some((need) => need.kind !== 'approval'))
      throw new Error(`Synthetic workflow failed: ${JSON.stringify(blocking)}`);
    for (const need of blocking) {
      let decision;
      let role = 'operator';
      if (need.step.endsWith('/screenCompliance')) {
        decision = need.subject.includes('example-denied') ? 'deny' : 'enter';
        role = 'reviewer';
      } else if (need.step.endsWith('/assignCarrier')) {
        const id = need.subject.slice('shipment:'.length);
        const shipment = planned.plan.shipments.find((shipment) => shipment.id === id);
        decision =
          input.carriers[id]?.kind === 'own'
            ? 'own'
            : shipment.carrier.kind === 'seller'
              ? 'seller'
              : `forwarder:${forwarder.id}`;
      } else if (need.step.endsWith('/confirmPacking')) decision = 'confirm';
      else if (need.step.endsWith('/collectQuotes')) decision = 'choose';
      else throw new Error(`Unexpected gate ${need.step}`);
      ctx.approvals.push({
        step: need.step,
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision,
        role,
        by: 'example:approver',
        at: DELIVERY_NOW,
      });
    }
  }
  throw new Error('Synthetic approval loop did not converge');
}
export async function generateDeliveryExample(directory = deliveryDirectory) {
  const { records, input, ctx, result } = await approvedDelivery();
  const write = async (path, data) => {
    const target = resolve(directory, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
  };
  for (const slot of new Set(records.map((record) => record.slot)))
    await write(`assets/${slot}.json`, {
      $example: 'synthetic',
      items: records.filter((record) => record.slot === slot),
    });
  await write('inputs/landed-delivery.json', input);
  await write('approvals/landed-delivery.json', ctx.approvals);
  await write('expected/delivery-plan.json', result.artifact);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateDeliveryExample();
