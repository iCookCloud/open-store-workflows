import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_SLOTS, versionHash } from '@osw/core';
import { FileSource, executeWorkflow } from '@osw/core/node';
import { slots, workflow } from '../dist/index.js';
import {
  ACTOR,
  NOW,
  exampleDirectory,
  generateWarehouseExample,
} from './generate-warehouse-example.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(packageDirectory, '.osw'), { recursive: true });
const scratch = await mkdtemp(join(packageDirectory, '.osw/warehouse-'));
const { input, ctx } = await generateWarehouseExample(scratch);
async function compare(path = '') {
  for (const entry of await readdir(join(scratch, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await compare(child);
    else
      assert.equal(
        await readFile(join(scratch, child), 'utf8'),
        await readFile(join(exampleDirectory, child), 'utf8'),
        `Warehouse golden differs: ${child}`,
      );
  }
}
await compare();
const source = await FileSource.open(join(scratch, 'assets'), [...SHARED_SLOTS, ...slots]);
const options = { source, now: NOW, actor: ACTOR };
const blocked = await executeWorkflow(workflow, input, options);
assert.equal(blocked.exitCode, 2);
const approved = await executeWorkflow(workflow, input, {
  ...options,
  approvals: ctx.approvals,
  record: true,
});
assert.equal(approved.exitCode, 0);
const artifact = approved.result.artifact;
assert.deepEqual(
  artifact,
  JSON.parse(await readFile(join(exampleDirectory, 'expected.json'), 'utf8')),
);
assert.equal(artifact.hash, await versionHash(artifact.body));
// 独立手算：2 箱×80 EUR×2 = 320 USD；12 件×10 USD = 120 USD。
assert.deepEqual(
  artifact.body.shipments
    .flatMap((shipment) => shipment.lines)
    .map((line) => line.declaredValue.amount)
    .sort((a, b) => a - b),
  [120, 320],
);
assert.deepEqual(
  artifact.body.arrivals.map((line) => line.receivedQty).sort((a, b) => a - b),
  [12, 20],
);
assert.equal(artifact.storeId, null);
assert.equal(
  artifact.inputs.some((ref) => ref.kind === 'Bom'),
  false,
);
assert.equal(artifact.body.allReceived, true);
assert(
  artifact.body.shipments.every(
    (shipment) =>
      shipment.status === 'received' && shipment.consignee.company === 'Example Warehouse',
  ),
);
const verifications = (await readFile(join(scratch, 'assets/_verifications.ndjson'), 'utf8'))
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert(
  verifications.some(
    (verification) => verification.dimension === 'transitDays' && verification.verdict === 'fails',
  ),
);
console.log(
  'Warehouse example passed: LineItem orders, quote tiers, FX, approvals and signed receipt',
);
