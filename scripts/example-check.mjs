import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_ACTOR, EXAMPLE_NOW, exampleDirectory, generateExamples } from './gen-examples.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(resolve(tmpdir(), 'osw-example-'));
const generated = resolve(scratch, 'generated');
await generateExamples(generated);
async function compareDirectory(path = '') {
  for (const entry of await readdir(resolve(generated, path), { withFileTypes: true })) {
    const child = resolve(generated, path, entry.name);
    const relativePath = [path, entry.name].filter(Boolean).join('/');
    if (entry.isDirectory()) await compareDirectory(relativePath);
    else
      assert.equal(
        await readFile(child, 'utf8'),
        await readFile(resolve(exampleDirectory, relativePath), 'utf8'),
        `Generated fixture changed: ${relativePath}`,
      );
  }
}
await compareDirectory();
const cli = resolve(root, 'packages/core/dist/node/cli.js');
const base = [
  cli,
  'store-concept',
  'run',
  '--assets',
  resolve(generated, 'assets'),
  '--in',
  resolve(generated, 'inputs/store-concept.json'),
  '--now',
  EXAMPLE_NOW,
  '--actor',
  EXAMPLE_ACTOR,
];
const blocked = spawnSync(process.execPath, [...base, '--out-dir', resolve(scratch, 'blocked')], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(
  blocked.status,
  2,
  `Without approvals the CLI must block: ${blocked.stderr}\n${blocked.stdout}`,
);
const completed = spawnSync(
  process.execPath,
  [
    ...base,
    '--approvals',
    resolve(generated, 'approvals/store-concept.json'),
    '--out-dir',
    resolve(scratch, 'approved'),
    '--record',
  ],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(completed.status, 0, `Approved CLI failed: ${completed.stderr}\n${completed.stdout}`);
const actualArtifact = JSON.parse(
  await readFile(resolve(scratch, 'approved/artifact.json'), 'utf8'),
);
const expectedArtifact = JSON.parse(
  await readFile(resolve(exampleDirectory, 'expected/store-spec.json'), 'utf8'),
);
assert.deepEqual(actualArtifact, expectedArtifact, 'CLI artifact must match the golden artifact');
// 此处独立手算，防止生成器把同一个计算错误同时写进实际值和预期值。
const usd = (amount) => ({ amount, currency: 'USD' });
assert.deepEqual(actualArtifact.body.economics.totals, {
  investment: usd(37400),
  monthlyRevenue: usd(40000),
  tax: usd(4000),
  monthlyCost: usd(23000),
  monthlyProfit: usd(17000),
});
assert.deepEqual(actualArtifact.body.economics.budgetRange, {
  low: usd(45000),
  high: usd(53000),
  basis: 'actuals',
  sampleSize: 2,
});
assert.deepEqual(actualArtifact.body.area, { targetM2: 100, minM2: 80, maxM2: 120 });
const verifications = (await readFile(resolve(generated, 'assets/_verifications.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert(
  verifications.some((verification) => verification.verdict === 'fails'),
  'The sample must detect at least one actual discrepancy',
);
console.log(
  `Example passed: reproducible fixtures, blocking approval, approved CLI and failed verification (${scratch})`,
);
