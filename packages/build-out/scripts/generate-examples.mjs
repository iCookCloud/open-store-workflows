import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildOutInput, workflow } from '@osw/build-out';
import { MemorySource, SHARED_SLOTS, assetRef, createParamReader, versionHash } from '@osw/core';
import { readExampleJson, writeExampleJson } from '@osw/core/node';

export const exampleDirectory = fileURLToPath(new URL('../examples/', import.meta.url));
const upstreamDirectory = fileURLToPath(new URL('../examples/upstream/', import.meta.url));

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
  const [site, bom, delivery] = await Promise.all(
    ['site-decision', 'bom', 'delivery-plan'].map((name) =>
      readExampleJson(resolve(upstreamDirectory, `${name}.json`)),
    ),
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
export async function generateBuildOutExamples(directory = exampleDirectory) {
  const { records, input } = await buildOutExample();
  const save = async (path, data) => {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(resolve(directory, path), `${JSON.stringify(data, null, 2)}\n`);
  };
  for (const slot of new Set(records.map((r) => r.slot))) {
    const path = `assets/${slot}.json`;
    await save(path, {
      $example: 'synthetic',
      items: records.filter((record) => record.slot === slot),
    });
  }
  for (const name of ['site-decision', 'bom', 'delivery-plan'])
    await writeExampleJson(
      resolve(directory, 'upstream', `${name}.json`),
      await readExampleJson(resolve(upstreamDirectory, `${name}.json`)),
    );
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateBuildOutExamples(process.argv[2] ? resolve(process.argv[2]) : exampleDirectory);
