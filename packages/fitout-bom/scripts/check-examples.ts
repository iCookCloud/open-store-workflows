import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareExampleTrees, exampleScratch, runExampleCli } from '@osw/core/node';
import { workflow } from '@osw/fitout-bom';
import { exampleDirectory, generateFitoutExample } from './generate-examples.js';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await exampleScratch('fitout');
const generated = join(scratch, 'generated');
await generateFitoutExample(generated);
await compareExampleTrees(generated, exampleDirectory);
const assets = join(scratch, 'assets');
await cp(join(generated, 'assets'), assets, { recursive: true });
const base = [
  'fitout-bom',
  'run',
  '--assets',
  assets,
  '--in',
  join(generated, 'inputs/fitout-bom.json'),
  '--now',
  '2026-01-01T12:00:00Z',
  '--actor',
  'osw:fitout-bom/test@0.1.0',
];
await runExampleCli(workflow, [...base, '--out-dir', join(scratch, 'blocked')], {
  cwd: packageDirectory,
  expectedExit: 2,
});
const { result } = await runExampleCli(
  workflow,
  [
    ...base,
    '--approvals',
    join(generated, 'approvals/fitout-bom.json'),
    '--out-dir',
    join(scratch, 'approved'),
    '--record',
  ],
  { cwd: packageDirectory, expectedExit: 0 },
);
assert.deepEqual(
  result.artifact,
  JSON.parse(await readFile(join(exampleDirectory, 'expected/bom.json'), 'utf8')),
);
// 独立手算金额及逐一报价判定，防止生成器和流程同时掩盖错误。
assert.deepEqual(result.artifact.body.totals.chosen, { amount: 200, currency: 'USD' });
assert.deepEqual(result.artifact.body.totals.model, { amount: 200, currency: 'USD' });
const checks = (await readFile(join(assets, '_verifications.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((v) => v.asset.slot === 'offer');
assert.deepEqual(checks.map((v) => v.verdict).sort(), ['fails', 'holds', 'pending']);
console.log(
  'Fitout example passed: blocked approval, reproducible Bom, and three recorded offer verdicts',
);
