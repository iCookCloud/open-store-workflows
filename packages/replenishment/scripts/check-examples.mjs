import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareExampleTrees,
  exampleScratch,
  readExampleJson,
  runExampleCli,
} from '@osw/core/node';
import { workflow } from '@osw/replenishment';
import {
  REPLENISHMENT_ACTOR,
  REPLENISHMENT_NOW,
  exampleDirectory,
  generateReplenishmentExamples,
} from './generate-examples.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await exampleScratch('replenishment');
const generated = resolve(scratch, 'generated');
await generateReplenishmentExamples(generated);
await compareExampleTrees(generated, exampleDirectory);
for (const name of ['replenishment', 'replenishment-reorder']) {
  const base = [
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
  await runExampleCli(workflow, [...base, '--out-dir', resolve(scratch, `${name}-blocked`)], {
    cwd: packageDirectory,
    expectedExit: 2,
  });
  await runExampleCli(
    workflow,
    [
      ...base,
      '--approvals',
      resolve(generated, `approvals/${name}.json`),
      '--out-dir',
      resolve(scratch, name),
      '--record',
    ],
    { cwd: packageDirectory, expectedExit: 0 },
  );
  const artifact = await readExampleJson(resolve(scratch, name, 'artifact.json'));
  assert.deepEqual(
    artifact,
    await readExampleJson(resolve(exampleDirectory, `expected/${name}.json`)),
  );
  assert(
    !JSON.stringify(artifact).includes('@example.com'),
    'SupplyProgram must not expose recipient email addresses',
  );
  assert.equal(artifact.body.segmentation.total, 5);
  assert.equal(artifact.body.segmentation.unclassified.count, 3);
  if (name === 'replenishment-reorder') {
    const transition = await readExampleJson(resolve(scratch, name, 'advanceReorders.json'));
    assert.equal(transition.output.orders[0].order.lines[0].unitPrice.amount, 20);
    assert.equal(transition.output.orders[0].order.state, 'submitted');
  }
}
console.log(
  'Replenishment examples passed: isolated opening/BOM JSON, campaign/reorder approvals, golden artifacts, private-data projection and memory send ledger',
);
