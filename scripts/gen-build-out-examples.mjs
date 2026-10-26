import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BuildOutInput, workflow } from '@osw/build-out';
import { MemorySource, SHARED_SLOTS, assetRef, createParamReader, versionHash } from '@osw/core';

export const BUILD_EXAMPLE_NOW = '2026-01-30T00:00:00Z';
export const BUILD_EXAMPLE_ACTOR = 'example:reviewer';
const usd = (amount) => ({ amount, currency: 'USD' });

// 完全虚构的常数，与真实门店、施工方、单价和工时无关。
export async function buildOutExample() {
  const records = [];
  const add = async (slot, id, data) => {
    const hash = await versionHash(data);
    const record = {
      slot,
      id,
      slotVersion: '0.1.0',
      versionHash: hash,
      fieldsetHashes: { price: hash, terms: hash },
      coverage: {
        tier: 'track',
        tracks: ['example-noodle'],
        workflows: ['build-out'],
        jurisdictions: ['XE'],
      },
      updatedAt: BUILD_EXAMPLE_NOW,
      example: true,
      data,
    };
    records.push(record);
    return record;
  };
  for (const [key, value, unit] of [
    ['labor.hourlyRate', 20, 'USD/h'],
    ['build.minBids', 3],
    ['build.crewSize', 2],
    ['build.hoursPerDay', 10, 'h'],
    ['build.workdays', '1,2,3,4,5'],
    ['verify.installHours.tolerancePct', 10, '%'],
    ['verify.siteMeasure.tolerancePct', 10, '%'],
  ])
    await add('params', `example-build-${key.replaceAll('.', '-')}`, {
      key,
      value,
      ...(unit ? { unit } : {}),
      appliesTo: { jurisdictions: ['XE'], tracks: ['example-noodle'] },
    });
  await add('install-rate', 'example-carpentry-rate', {
    match: { category: ['example-casework'], unit: ['pcs'] },
    priority: 10,
    hoursPerUnit: 2,
    unit: 'pcs',
    basis: 'Invented installation allowance',
    trade: 'carpentry',
    source: 'estimate',
  });
  await add('install-rate', 'example-electrical-rate', {
    match: { category: ['example-appliance'], unit: ['pcs'] },
    priority: 10,
    hoursPerUnit: 4,
    unit: 'pcs',
    basis: 'Invented installation allowance',
    trade: 'electrical',
    source: 'estimate',
  });
  await add('build-fee', 'example-build-percentage', {
    name: 'Example handling',
    basis: 'pctOfGoods',
    pct: 10,
    autoAdd: true,
    freight: false,
  });
  await add('build-fee', 'example-build-fixed', {
    name: 'Example setup',
    basis: 'fixed',
    rate: usd(50),
    autoAdd: true,
    freight: false,
  });
  await add('build-fee', 'example-build-volume', {
    name: 'Example storage',
    basis: 'perVolume',
    rate: usd(30),
    autoAdd: true,
    freight: false,
  });
  const contractors = [];
  for (const [id, name, amount] of [
    ['example-builder-a', 'Example Builder A', 2000],
    ['example-builder-b', 'Example Builder B', 2200],
  ]) {
    contractors.push(
      await add('party', id, {
        name: { en: name },
        roles: ['contractor'],
        status: 'active',
        jurisdictions: ['XE'],
        profiles: { contractor: { trades: ['carpentry', 'electrical'], licenses: [] } },
      }),
    );
    await add('offer', `${id}-bid`, {
      partyId: id,
      serviceScope: 'Example installation',
      basis: 'quote',
      use: 'project',
      currency: 'USD',
      unit: 'lot',
      tiers: [{ minQty: 1, unitPrice: amount }],
      quotedAt: '2026-01-01',
      serviceLineRefs: ['example-counter', 'example-appliance'],
      hoursPerUnit: 30,
    });
  }
  const forwarder = await add('party', 'example-delivery-party', {
    name: { en: 'Example Carrier' },
    roles: ['forwarder'],
    status: 'active',
  });
  await add('template', 'example-build-phases', {
    kind: 'buildout-phases',
    lang: 'en',
    title: { en: 'Example build phases' },
    format: 'json',
    content: {
      phases: [
        { key: 'casework', title: 'Example casework', dependsOn: [], trades: ['carpentry'] },
        { key: 'equipment', title: 'Example equipment', dependsOn: [], trades: ['electrical'] },
        {
          key: 'inspection',
          title: 'Example inspection',
          dependsOn: ['casework', 'equipment'],
          checkpoint: 'example-signoff',
        },
      ],
    },
  });
  await add('template', 'example-build-acceptance', {
    kind: 'buildout-acceptance',
    lang: 'en',
    title: { en: 'Example acceptance' },
    format: 'json',
    content: {
      items: [
        {
          key: 'example-check',
          title: 'Example completion evidence',
          ownerRole: 'owner',
          dependsOn: [],
          evidence: 'Evidence reference',
          gate: true,
        },
      ],
    },
  });
  const ref = async (slot, id) => ({ slot, id, versionHash: await versionHash({ example: id }) });
  const listing = await ref('listing', 'example-listing');
  const bomCase = await ref('bom-case', 'example-bom-case');
  const envelope = async (kind, body, sources, inputs = []) => ({
    kind,
    artifactVersion: '0.1.0',
    id: `example-${kind.toLowerCase()}`,
    hash: await versionHash(body),
    producedBy: {
      step: `${kind === 'Bom' ? 'fitout-bom' : kind === 'SiteDecision' ? 'site-search' : 'landed-delivery'}/run`,
      pkg: '@osw/example',
      pkgVersion: '0.1.0',
    },
    storeId: 'example-noodle-store',
    inputs,
    sources,
    createdAt: BUILD_EXAMPLE_NOW,
    example: true,
    body,
  });
  const line = (id, name, qty, price, category, kind, volume) => ({
    id,
    name,
    qty,
    unit: 'pcs',
    lineKind: kind,
    category,
    zone: 'example-room',
    spec: 'Invented specification',
    qtyRule: { kind: 'manual' },
    qtyBasis: { status: 'manual', note: 'Synthetic' },
    dimsBasis: { status: 'manual', note: 'Synthetic' },
    budgetKey: 'furnishing',
    evidence: [],
    derivedFrom: { kind: 'case', ref: bomCase.id },
    pricingMode: 'custom',
    components: [
      {
        key: 'example-part',
        name: 'Example material',
        kind: 'material',
        basis: 'fixed',
        qtyPerUnit: 1,
        unit: 'pcs',
        rate: usd(price),
        rateNote: 'Invented',
      },
    ],
    modelCostPerUnit: usd(price),
    parts: [
      {
        key: 'example-part',
        name: 'Example material',
        kind: 'material',
        qty: 1,
        unit: 'pcs',
        rate: usd(price),
        total: usd(price),
        note: 'Invented',
      },
    ],
    modelWarnings: [],
    sourcing: null,
    costBasis: 'model',
    unitPrice: { ...usd(price), basis: 'model' },
    installKind: 'fixed',
    volumePerUnit: volume,
  });
  const bom = await envelope(
    'Bom',
    {
      currency: 'USD',
      lines: [
        line('example-counter', 'Example counter', 10, 100, 'example-casework', 'furniture', 0.1),
        line(
          'example-appliance',
          'Example appliance',
          2,
          200,
          'example-appliance',
          'equipment',
          0.5,
        ),
        line(
          'example-landlord-panel',
          'Example landlord panel',
          1,
          100,
          'example-casework',
          'fitout',
          0.1,
        ),
      ],
      totals: { model: usd(1500), chosen: usd(1500), byBudgetKey: {} },
    },
    [bomCase],
  );
  const site = await envelope(
    'SiteDecision',
    {
      stage: 'chosen',
      listing,
      address: { line1: 'Example Unit', locality: 'Example Town', jurisdiction: 'XE' },
      geo: { lat: 0, lng: 0 },
      jurisdiction: 'XE',
      unit: 'Example Unit',
      floorLevel: 0,
      conditions: [
        {
          key: 'area',
          measure: { value: 100, unit: 'm2', basis: 'observed' },
          required: { key: 'area', op: 'gte', value: 80, unit: 'm2', hard: true },
          verdict: 'holds',
        },
      ],
      unmeasured: [],
      openingTarget: '2026-02-01',
      lease: {
        termMonths: 12,
        renewals: [],
        possessionDate: '2026-01-05',
        rentCommencementDate: '2026-02-01',
        rent: {
          base: usd(1000),
          period: 'month',
          basis: 'total',
          escalation: { kind: 'none', value: null, everyMonths: 12 },
          freeRentMonths: 0,
          additional: [],
        },
        deposit: null,
        tiAllowance: null,
        guarantee: { kind: 'none', cap: null },
        permittedUse: 'Example food store',
        exclusiveUse: false,
        assignment: 'consent',
        deliveryCondition: 'as_is',
        landlordWork: ['Example landlord panel'],
        documents: [],
      },
      shortlist: [{ listing, status: 'chosen', reason: 'Synthetic choice' }],
    },
    [listing],
  );
  const milestone = { date: '2026-01-07', basis: 'received', shipmentIds: ['example-shipment'] };
  const cell = { value: null, src: null };
  const shipment = {
    id: 'example-shipment',
    origin: 'XE',
    goodsClass: 'nonfood',
    mode: 'ground',
    crossBorder: false,
    status: 'received',
    node: 'delivered',
    consignee: {},
    portFrom: null,
    portTo: null,
    lastMile: [],
    carrier: { kind: 'forwarder', partyRef: assetRef(forwarder) },
    lines: bom.body.lines.slice(0, 2).map((l) => ({
      id: `packing-${l.id}`,
      bomLineId: l.id,
      lineKind: l.lineKind,
      offerRef: { slot: 'offer', id: `example-goods-${l.id}`, versionHash: '0'.repeat(64) },
      name: l.name,
      spec: l.spec,
      qty: l.id === 'example-counter' ? 20 : 2,
      goodsClass: 'nonfood',
      goodsClassSrc: 'manual',
      hsCode: cell,
      materialText: cell,
      netWeightKg: cell,
      cartonUnits: cell,
      cartons: cell,
      totalNetWeightKg: cell,
      totalGrossWeightKg: cell,
      totalVolumeM3: cell,
      declaredValue: usd(0),
    })),
    quotes: [],
    chosenQuoteId: null,
    freight: usd(80),
    documents: [],
    tracking: {},
    holds: [],
    arrival: null,
    amendments: [],
  };
  const delivery = await envelope(
    'DeliveryPlan',
    {
      market: 'XE',
      compliance: [],
      held: [],
      shipments: [shipment],
      arrivals: [
        {
          bomLineId: 'example-counter',
          shipmentId: shipment.id,
          qty: 20,
          basis: 'received',
          eta: '2026-01-05',
          arrivedAt: '2026-01-05',
          receivedQty: 20,
          damagedQty: 0,
        },
        {
          bomLineId: 'example-appliance',
          shipmentId: shipment.id,
          qty: 2,
          basis: 'received',
          eta: '2026-01-07',
          arrivedAt: '2026-01-07',
          receivedQty: 2,
          damagedQty: 0,
        },
      ],
      fitoutGoodsLastAt: milestone,
      openingStock: {
        status: 'none',
        firstAt: { date: null, basis: 'none', shipmentIds: [] },
        lastAt: { date: null, basis: 'none', shipmentIds: [] },
      },
      allReceived: true,
    },
    [assetRef(forwarder)],
    [{ kind: bom.kind, id: bom.id, hash: bom.hash }],
  );
  const input = BuildOutInput.parse({
    bom,
    site,
    delivery,
    currency: 'USD',
    track: 'example-noodle',
    drawings: ['https://example.com/drawing'],
    landlordScope: [
      { item: 'Example landlord panel', lineIds: ['example-landlord-panel'], conditions: [] },
    ],
    offerIds: ['example-builder-a-bid', 'example-builder-b-bid'],
    phaseTemplateId: 'example-build-phases',
    acceptanceTemplateId: 'example-build-acceptance',
    startNotBefore: '2026-01-05',
    contractor: assetRef(contractors[0]),
    changes: [
      {
        id: 'example-extra-counter',
        reason: 'Synthetic increase in confirmed quantity',
        lineDeltas: [{ lineId: 'example-counter', qtyDelta: 10 }],
        priceDelta: usd(1530),
        scheduleDeltaDays: 0,
      },
    ],
    actuals: [
      {
        taskId: 'casework:carpentry',
        start: '2026-01-05',
        end: '2026-01-06',
        hours: 50,
        by: 'example:builder',
      },
      {
        taskId: 'equipment:electrical',
        start: '2026-01-07',
        end: '2026-01-07',
        hours: 8,
        by: 'example:builder',
      },
      {
        taskId: 'inspection',
        start: '2026-01-08',
        end: '2026-01-08',
        hours: 0,
        by: 'example:reviewer',
      },
    ],
    checkpoints: [
      {
        key: 'example-signoff',
        passedAt: '2026-01-08',
        evidenceRefs: ['https://example.com/signoff'],
      },
    ],
    acceptance: {
      checklist: [
        { key: 'example-check', done: true, evidenceRefs: ['https://example.com/completion'] },
      ],
      installed: [
        { lineId: 'example-counter', qty: 20 },
        { lineId: 'example-appliance', qty: 2 },
      ],
      asBuilt: [{ key: 'area', measure: { value: 100, unit: 'm2', basis: 'observed' } }],
      landlord: [
        {
          item: 'Example landlord panel',
          delivered: true,
          evidenceRefs: ['https://example.com/landlord'],
        },
      ],
      possession: { observed: 'as_is', evidenceRefs: ['https://example.com/possession'] },
      handover: [{ kind: 'as-built', ref: 'https://example.com/as-built' }],
      actualFinish: '2026-01-08',
    },
  });
  return { records, input };
}
export function buildContext(records, approvals = []) {
  return {
    assets: new MemorySource(records, [...SHARED_SLOTS, ...workflow.slots]),
    params: createParamReader(
      records.filter((r) => r.slot === 'params'),
      BUILD_EXAMPLE_NOW,
    ),
    approvals,
    providers: {},
    now: BUILD_EXAMPLE_NOW,
    actor: BUILD_EXAMPLE_ACTOR,
  };
}
export async function approveBuildExample(input, ctx) {
  const approvals = [...ctx.approvals];
  for (let i = 0; i < 10; i++) {
    const result = await workflow.run(input, { ...ctx, approvals });
    const gate = result.needs.find(
      (n) =>
        n.kind === 'approval' &&
        !approvals.some((a) => a.step === n.step && a.subjectHash === n.subjectHash),
    );
    if (!gate) return { result, approvals };
    const base = {
      step: gate.step,
      subjectHash: gate.subjectHash,
      ...(gate.subject ? { subject: gate.subject } : {}),
      at: BUILD_EXAMPLE_NOW,
    };
    if (gate.step === 'build-out/track')
      approvals.push(
        { ...base, role: 'owner', decision: 'approve', by: 'example:owner' },
        {
          ...base,
          role: 'contractor',
          decision: 'approve',
          by: 'example:builder',
          party: input.contractor,
        },
      );
    else {
      const role =
        gate.step === 'build-out/takeoff' || gate.step === 'build-out/levelBids'
          ? 'operator'
          : gate.step === 'build-out/priceQuote'
            ? 'client'
            : 'owner';
      const decision =
        gate.step === 'build-out/takeoff'
          ? 'confirm'
          : gate.step === 'build-out/levelBids'
            ? 'proceed'
            : 'accept';
      approvals.push({
        ...base,
        role,
        decision,
        by: `example:${role}`,
        note: 'Explicit approval for invented example only',
      });
    }
  }
  throw new Error('Synthetic approval sequence did not converge');
}
export async function generateBuildOutExamples(directory) {
  const { records, input } = await buildOutExample();
  const save = async (path, data) => {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(resolve(directory, path), `${JSON.stringify(data, null, 2)}\n`);
  };
  for (const slot of new Set(records.map((r) => r.slot))) {
    const path = `assets/${slot}.json`;
    let existing = [];
    try {
      existing = JSON.parse(await readFile(resolve(directory, path), 'utf8')).items;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const added = records.filter((r) => r.slot === slot);
    await save(path, {
      $example: 'synthetic',
      items: [...existing.filter((r) => !added.some((a) => a.id === r.id)), ...added],
    });
  }
  const { result, approvals } = await approveBuildExample(input, buildContext(records));
  if (
    !result.artifact ||
    result.artifact.body.acceptance.status !== 'accepted' ||
    result.needs.some((n) => n.blocking)
  )
    throw new Error(`Build example failed: ${JSON.stringify(result.needs)}`);
  await save('inputs/build-out.json', input);
  await save('approvals/build-out.json', approvals);
  await save('expected/build-plan.json', result.artifact);
  return result;
}
