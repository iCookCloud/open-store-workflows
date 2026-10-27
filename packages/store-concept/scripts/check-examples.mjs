import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareExampleTrees,
  exampleScratch,
  readExampleJson,
  runExampleCli,
} from '@osw/core/node';
import { workflow } from '@osw/store-concept';
import {
  EXAMPLE_ACTOR,
  EXAMPLE_NOW,
  exampleDirectory,
  generateExamples,
} from './generate-examples.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await exampleScratch('store-concept');
const generated = join(scratch, 'generated');
await generateExamples(generated);
await compareExampleTrees(generated, exampleDirectory);
const args = [
  'store-concept',
  'run',
  '--assets',
  join(generated, 'assets'),
  '--in',
  join(generated, 'inputs/store-concept.json'),
  '--now',
  EXAMPLE_NOW,
  '--actor',
  EXAMPLE_ACTOR,
];
const blocked = await runExampleCli(workflow, [...args, '--out-dir', join(scratch, 'blocked')], {
  cwd: packageDirectory,
  expectedExit: 2,
});
assert(
  blocked.result.needs.some(
    (need) => need.kind === 'approval' && need.step === 'store-concept/assembleSpec',
  ),
);
await runExampleCli(
  workflow,
  [
    ...args,
    '--approvals',
    join(generated, 'approvals/store-concept.json'),
    '--record',
    '--out-dir',
    join(scratch, 'approved'),
  ],
  { cwd: packageDirectory, expectedExit: 0 },
);
const artifact = await readExampleJson(join(scratch, 'approved/artifact.json'));
assert.deepEqual(
  artifact,
  await readExampleJson(join(exampleDirectory, 'expected/store-spec.json')),
);
// 独立手算，不能让生成器把同一错误同时写进实际与黄金产物。
const usd = (amount) => ({ amount, currency: 'USD' });
assert.deepEqual(artifact.body.economics.totals, {
  investment: usd(37400),
  monthlyRevenue: usd(40000),
  tax: usd(4000),
  monthlyCost: usd(23000),
  monthlyProfit: usd(17000),
});
assert.deepEqual(artifact.body.economics.budgetRange, {
  low: usd(45000),
  high: usd(53000),
  basis: 'actuals',
  sampleSize: 2,
});
assert.deepEqual(artifact.body.area, { targetM2: 100, minM2: 80, maxM2: 120 });
const verifications = (await readFile(join(generated, 'assets/_verifications.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert(verifications.some((verification) => verification.verdict === 'fails'));
console.log(
  'Store concept example passed: isolated assets, approval gates, hand-calculated totals and recorded failures',
);
