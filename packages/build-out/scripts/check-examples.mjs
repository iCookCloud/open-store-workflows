import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflow } from '@osw/build-out';
import {
  compareExampleTrees,
  exampleScratch,
  readExampleJson,
  runExampleCli,
} from '@osw/core/node';
import {
  BUILD_EXAMPLE_ACTOR,
  BUILD_EXAMPLE_NOW,
  exampleDirectory,
  generateBuildOutExamples,
} from './generate-examples.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await exampleScratch('build-out');
const generated = resolve(scratch, 'generated');
await generateBuildOutExamples(generated);
await compareExampleTrees(generated, exampleDirectory);
const base = [
  'build-out',
  'run',
  '--assets',
  resolve(generated, 'assets'),
  '--in',
  resolve(generated, 'inputs/build-out.json'),
  '--now',
  BUILD_EXAMPLE_NOW,
  '--actor',
  BUILD_EXAMPLE_ACTOR,
];
await runExampleCli(workflow, [...base, '--out-dir', resolve(scratch, 'blocked')], {
  cwd: packageDirectory,
  expectedExit: 2,
});
await runExampleCli(
  workflow,
  [
    ...base,
    '--approvals',
    resolve(generated, 'approvals/build-out.json'),
    '--out-dir',
    resolve(scratch, 'approved'),
  ],
  { cwd: packageDirectory, expectedExit: 0 },
);
const artifact = await readExampleJson(resolve(scratch, 'approved/artifact.json'));
assert.deepEqual(
  artifact,
  await readExampleJson(resolve(exampleDirectory, 'expected/build-plan.json')),
);
// 独立手算：20×140 + 2×280 + 240 + 50 + 90 + 80 = 3820。
assert.equal(artifact.body.quote.totals.total.amount, 3820);
assert.equal(artifact.body.schedule.finish, '2026-01-08');
assert.equal(artifact.body.acceptance.status, 'accepted');
assert.equal(artifact.body.changes[0].status, 'effective');
const tracked = await readExampleJson(resolve(scratch, 'approved/track.json'));
assert(
  tracked.verifications.some((v) => v.dimension === 'hoursPerUnit' && v.verdict === 'fails'),
  'Deliberately higher actual installation hours must remain visible',
);
console.log(
  'Build example passed: isolated upstream JSON, golden artifact, approval gates, signed change, CPM and installation verification',
);
