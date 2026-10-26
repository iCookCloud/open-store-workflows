import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySource, createParamReader, versionHash } from '@osw/core';
import { workflow } from '@osw/store-concept';
import { generateReplenishmentExamples } from './gen-replenishment-examples.mjs';
import { openingAssets, saveOpeningExample } from './opening-examples.mjs';

export const EXAMPLE_NOW = '2026-01-01T00:00:00Z';
export const EXAMPLE_ACTOR = 'example:reviewer';
export const exampleDirectory = fileURLToPath(
  new URL('../examples/sample-store/', import.meta.url),
);

// 示例数字均为独立构造的整十常数，固定种子仅用于排序可重现的示例编号。
function seededNumbers(seed) {
  let state = seed;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

export async function exampleAssets() {
  const records = [];
  const sequence = seededNumbers(20261026);
  const add = async (slot, id, data) => {
    const record = {
      slot,
      id,
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      coverage: {
        tier: 'track',
        tracks: ['example-noodle'],
        workflows: ['store-concept'],
        jurisdictions: ['XE'],
      },
      updatedAt: EXAMPLE_NOW,
      example: true,
      data,
    };
    records.push(record);
    return record;
  };
  const param = (key, kind, algorithm, baseValue, baseAreaM2 = null, storeIds = []) => ({
    key,
    kind,
    algorithm,
    baseValue,
    baseAreaM2,
    provenance: { kind: 'actual', storeIds, note: 'Invented synthetic fixture' },
  });
  await add('calc-template', 'example-noodle-template', {
    storeType: 'example-noodle',
    track: 'example-noodle',
    cuisines: ['example-noodle'],
    nonFood: false,
    revenueModel: 'covers',
    currency: 'USD',
    baseAreaM2: 100,
    seatRatio: 0.5,
    turnover: 2,
    spend: 20,
    taxRate: 0.1,
    opDays: 20,
    hasDefaults: true,
    params: [
      param('equipment', 'investment', 'area_scale', 10000, 100, ['example-store-1']),
      param('furnishing', 'investment', 'fixed', 4000),
      param('construction', 'investment', 'area_scale', 20000, 100),
      param('working_capital', 'investment', 'subtotal_percent', 0.1),
      param('rent', 'monthly', 'fixed', 2000),
      param('labor', 'monthly', 'fixed', 4000),
      param('utilities', 'monthly', 'fixed', 1000),
      param('food_cost', 'monthly', 'revenue_percent', 0.3),
    ],
    staffing: [{ positionKey: 'example-cook', headcount: 2, algorithm: 'area_scale' }],
  });
  await add('site-profile', 'example-noodle-site-profile', {
    storeType: 'example-noodle',
    requirements: [
      {
        key: 'powerCapacity',
        op: 'gte',
        value: 30,
        unit: 'kW',
        hard: true,
        reason: 'Synthetic equipment allowance',
      },
    ],
    equipmentTriggers: [
      {
        termKeys: ['example-induction'],
        requirement: {
          key: 'serviceVoltage',
          op: 'gte',
          value: 220,
          unit: 'V',
          hard: true,
          reason: 'Synthetic induction requirement',
        },
      },
    ],
  });
  await add('menu', 'example-menu-1', {
    title: { en: 'Example Noodle Menu' },
    cuisine: 'example-noodle',
    tracks: ['example-noodle'],
    origin: 'delivered',
    items: [{ id: 'example-dish', name: { en: 'Example Noodles' }, station: 'example-hot' }],
    pageCount: 2,
    derives: {
      ingredients: [{ key: 'example-noodle' }],
      equipment: [{ key: 'example-induction' }],
      sop: [{ key: 'example-boil' }],
      coldchain: false,
    },
  });
  await add('menu', 'example-menu-2', {
    title: { en: 'Example Alternative Menu' },
    cuisine: 'example-noodle',
    tracks: ['example-noodle'],
    origin: 'reference',
    pageCount: 1,
    derives: {
      ingredients: [{ key: 'example-noodle' }],
      equipment: [{ key: 'example-induction' }],
      sop: [{ key: 'example-boil' }],
      coldchain: false,
    },
  });
  for (const [key, kind] of [
    ['example-noodle', 'ingredient'],
    ['example-induction', 'equipment'],
    ['example-boil', 'sop'],
  ]) {
    await add('term', key, { key, kind, labels: { en: key } });
  }
  const amounts = [
    [8000, 3000, 18000, 3000],
    [12000, 5000, 24000, 4000],
    [14000, 6000, 28000, 5000],
  ];
  for (const [index, values] of amounts.entries()) {
    await add('store', `example-store-${index + 1}`, {
      name: { en: `Example Operating Store ${index + 1}` },
      status: 'operating',
      track: 'example-noodle',
      storeType: 'example-noodle',
      cuisine: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      areaM2: 100,
      geo: { lat: 0, lng: (sequence() % 10) / 1000 },
      actuals: values.map((amount, row) => ({
        key: ['equipment', 'furnishing', 'construction', 'working_capital'][row],
        amount: { amount, currency: 'USD' },
        basis: 'paid',
        at: EXAMPLE_NOW,
      })),
    });
  }
  for (const [key, value] of Object.entries({
    'concept.budgetBand': 0.2,
    'concept.areaTolerance': 0.2,
    'concept.calibrationMinSample': 2,
    'concept.minMarginRate': 0.1,
    'verify.calcTemplateTolerance': 0.1,
  })) {
    await add(
      'params',
      key.replaceAll('.', '-').replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
      {
        key,
        value,
        appliesTo: { jurisdictions: ['XE'], tracks: ['example-noodle'] },
        validFrom: '2025-01-01',
        validTo: '2030-12-31',
      },
    );
  }
  return records;
}

export const exampleInput = {
  storeId: 'example-opening-store',
  storeType: 'example-noodle',
  cuisine: 'example-noodle',
  jurisdiction: 'XE',
  timezone: 'UTC',
  areaM2: 100,
  budgetCap: { amount: 60000, currency: 'USD' },
  currency: 'USD',
};

export async function generateExamples(directory = exampleDirectory) {
  const records = [...(await exampleAssets()), ...(await openingAssets())];
  const slots = [...new Set(records.map((record) => record.slot))];
  const save = async (path, data) => {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(resolve(directory, path), `${JSON.stringify(data, null, 2)}\n`);
  };
  for (const slot of slots)
    await save(`assets/${slot}.json`, {
      $example: 'synthetic',
      items: records.filter((record) => record.slot === slot),
    });
  await save('inputs/store-concept.json', exampleInput);
  const menu = records.find((record) => record.id === 'example-menu-1');
  const approvals = [
    {
      step: 'store-concept/shortlistMenus',
      subject: `menu:${menu.id}`,
      subjectHash: menu.versionHash,
      decision: 'approve',
      by: EXAMPLE_ACTOR,
      at: EXAMPLE_NOW,
    },
  ];
  const context = {
    assets: new MemorySource(records, workflow.slots),
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      EXAMPLE_NOW,
      { jurisdiction: 'XE', track: 'example-noodle' },
    ),
    approvals,
    providers: {},
    now: EXAMPLE_NOW,
    actor: EXAMPLE_ACTOR,
  };
  const pending = await workflow.run(exampleInput, context);
  const gate = pending.needs.find(
    (need) => need.kind === 'approval' && need.step === 'store-concept/assembleSpec',
  );
  if (!gate) throw new Error(`Expected the release gate: ${JSON.stringify(pending.needs)}`);
  approvals.push({
    step: gate.step,
    subjectHash: gate.subjectHash,
    decision: 'release',
    by: EXAMPLE_ACTOR,
    at: EXAMPLE_NOW,
  });
  const approved = await workflow.run(exampleInput, { ...context, approvals });
  if (!approved.artifact || approved.needs.some((need) => need.blocking))
    throw new Error(`Example did not complete: ${JSON.stringify(approved.needs)}`);
  await save('approvals/store-concept.json', approvals);
  await save('expected/store-spec.json', approved.artifact);
  await saveOpeningExample(directory, records, approved.artifact);
  await generateReplenishmentExamples(directory, records);
  console.log(
    `Synthetic sample generated (${records.length} assets); artifact ${approved.artifact.hash}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateExamples(process.argv[2] ? resolve(process.argv[2]) : exampleDirectory);
}
