import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySource, ParamsSlot, assetRef, createParamReader } from '@osw/core';
import { bomCaseSlot, designSlot, materialRateSlot, run } from '../src/index.js';
import { approve, context, fixture, money, now, record } from '../tests/fixtures.js';

// 所有常数来自从零构造的测试夹具；批示仅供 example 数据使用。
export const exampleDirectory = fileURLToPath(new URL('../examples/', import.meta.url));
export async function generateFitoutExample(root = exampleDirectory) {
  const sample = await fixture();
  const material = await record(materialRateSlot, 'example-material', {
    name: 'Example panel',
    kind: 'material',
    group: 'board',
    unit: 'sheet',
    convert: 2,
    baseUnit: 'm2',
    price: money(200),
    basis: 'quote',
    source: 'Synthetic example',
    quotedAt: '2026-01-01',
    sheet: { l: 2000, w: 1000, t: 20 },
  });
  sample.draft.lines[0].components = [
    {
      key: 'top',
      name: 'Example panel',
      kind: 'material',
      basis: 'fixed',
      qtyPerUnit: 1,
      unit: 'm2',
      rateRef: assetRef(material),
    },
  ];
  const design = await record(designSlot, 'example-design', {
    kind: 'plan',
    images: [
      { url: 'https://example.com/synthetic-plan.png', sha256: '0'.repeat(64), aiGenerated: true },
    ],
    hotspots: [],
  });
  const bomCase = await record(bomCaseSlot, 'example-case', {
    title: 'Synthetic example fitout',
    designRefs: [assetRef(design)],
    lines: sample.draft.lines,
  });
  const params = await Promise.all(
    Object.entries({
      'bom.offerBand.low': 0.8,
      'bom.offerBand.high': 1.2,
      'bom.specTolerance': 10,
      'bom.rateCheckMinOffers': 2,
      'site.powerDiversity': 1,
    }).map(([key, value]) => record(ParamsSlot, key, { key, value, note: 'Synthetic example' })),
  );
  const records = [...sample.records, material, design, bomCase, ...params];
  const input = {
    seed: { caseId: bomCase.id, storeId: 'example-store' },
    store: sample.store,
    site: sample.site,
  };
  const ctx = {
    ...context(records),
    assets: new MemorySource(records),
    params: createParamReader(params, now),
  };
  let outcome = await run(input, ctx);
  for (let round = 0; outcome.artifact === null && round < 3; round++) {
    const approvals = outcome.needs.filter((n) => n.kind === 'approval');
    if (!approvals.length) throw new Error(JSON.stringify(outcome.needs));
    for (const need of approvals)
      ctx.approvals = [
        ...ctx.approvals,
        ...approve([need], need.step === 'fitout-bom/sourceLines' ? 'example-holds' : 'approve'),
      ];
    outcome = await run(input, ctx);
  }
  if (!outcome.artifact) throw new Error(JSON.stringify(outcome.needs));
  const write = async (path: string, value: unknown) => {
    const target = resolve(root, path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const slot of new Set(records.map((r) => r.slot)))
    await write(`assets/${slot}.json`, {
      $example: 'synthetic',
      items: records.filter((r) => r.slot === slot),
    });
  await write('inputs/fitout-bom.json', input);
  await write('approvals/fitout-bom.json', ctx.approvals);
  await write('expected/bom.json', outcome.artifact);
  await write(
    'expected/verifications.json',
    Object.values(outcome.steps).flatMap((s) => s.verifications),
  );
  console.log(`Generated synthetic fitout example: ${outcome.artifact.hash}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateFitoutExample(process.argv[2] ? resolve(process.argv[2]) : exampleDirectory);
}
