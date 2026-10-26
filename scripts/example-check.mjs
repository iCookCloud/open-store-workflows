import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_ACTOR, EXAMPLE_NOW, exampleDirectory, generateExamples } from './gen-examples.mjs';
import { REPLENISHMENT_ACTOR, REPLENISHMENT_NOW } from './gen-replenishment-examples.mjs';

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
for (const name of ['replenishment', 'replenishment-reorder']) {
  const base = [
    cli,
    'replenishment',
    'run',
    '--assets',
    resolve(generated, 'assets'),
    '--in',
    resolve(generated, `inputs/${name}.json`),
    '--now',
    REPLENISHMENT_NOW,
    '--actor',
    REPLENISHMENT_ACTOR,
  ];
  const blocked = spawnSync(
    process.execPath,
    [...base, '--out-dir', resolve(scratch, `${name}-blocked`)],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(blocked.status, 2, `Replenishment must require approval: ${blocked.stderr}`);
  const completed = spawnSync(
    process.execPath,
    [
      ...base,
      '--approvals',
      resolve(generated, `approvals/${name}.json`),
      '--out-dir',
      resolve(scratch, name),
      '--record',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(completed.status, 0, `Replenishment CLI failed: ${completed.stderr}`);
  const artifact = JSON.parse(await readFile(resolve(scratch, name, 'artifact.json'), 'utf8'));
  assert.deepEqual(
    artifact,
    JSON.parse(await readFile(resolve(exampleDirectory, `expected/${name}.json`), 'utf8')),
  );
  assert(
    !JSON.stringify(artifact).includes('@example.com'),
    'SupplyProgram must not expose email addresses',
  );
  assert.equal(artifact.body.segmentation.total, 5);
  assert.equal(artifact.body.segmentation.unclassified.count, 3);
  if (name === 'replenishment-reorder') {
    const transition = JSON.parse(
      await readFile(resolve(scratch, name, 'advanceReorders.json'), 'utf8'),
    );
    assert.equal(transition.output.orders[0].order.lines[0].unitPrice.amount, 20);
    assert.equal(transition.output.orders[0].order.state, 'submitted');
  }
}
console.log(
  `Example passed: reproducible fixtures, blocking approval, approved CLI and failed verification (${scratch})`,
);

const fitoutExample = resolve(root, 'examples/fitout-store');
const fitoutAssets = resolve(scratch, 'fitout-assets');
await cp(resolve(fitoutExample, 'assets'), fitoutAssets, { recursive: true });
const fitoutArgs = [
  cli,
  'fitout-bom',
  'run',
  '--assets',
  fitoutAssets,
  '--in',
  resolve(fitoutExample, 'inputs/fitout-bom.json'),
  '--now',
  '2026-01-01T12:00:00Z',
  '--actor',
  'osw:fitout-bom/test@0.1.0',
];
const fitoutBlocked = spawnSync(
  process.execPath,
  [...fitoutArgs, '--out-dir', resolve(scratch, 'fitout-blocked')],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(fitoutBlocked.status, 2, fitoutBlocked.stderr);
const fitoutCompleted = spawnSync(
  process.execPath,
  [
    ...fitoutArgs,
    '--approvals',
    resolve(fitoutExample, 'approvals/fitout-bom.json'),
    '--out-dir',
    resolve(scratch, 'fitout-approved'),
    '--record',
  ],
  { cwd: root, encoding: 'utf8' },
);
assert.equal(fitoutCompleted.status, 0, fitoutCompleted.stderr);
const fitoutArtifact = JSON.parse(
  await readFile(resolve(scratch, 'fitout-approved/artifact.json'), 'utf8'),
);
assert.deepEqual(
  fitoutArtifact,
  JSON.parse(await readFile(resolve(fitoutExample, 'expected/bom.json'), 'utf8')),
);
assert.deepEqual(fitoutArtifact.body.totals.chosen, usd(200));
assert.deepEqual(fitoutArtifact.body.totals.model, usd(200));
const fitoutChecks = (await readFile(resolve(fitoutAssets, '_verifications.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((v) => v.asset.slot === 'offer');
assert.deepEqual(fitoutChecks.map((v) => v.verdict).sort(), ['fails', 'holds', 'pending']);
console.log(
  'Fitout example passed: blocked approval, reproducible Bom, and three recorded offer verdicts',
);
