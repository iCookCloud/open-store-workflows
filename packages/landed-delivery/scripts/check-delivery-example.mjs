import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareExampleTrees, exampleScratch, runExampleCli } from '@osw/core/node';
import { workflow } from '@osw/landed-delivery';
import {
  DELIVERY_ACTOR,
  DELIVERY_NOW,
  deliveryDirectory,
  generateDeliveryExample,
} from './generate-delivery-example.mjs';

export async function checkDeliveryExample() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const scratch = await exampleScratch('delivery-example');
  const generated = resolve(scratch, 'generated');
  await generateDeliveryExample(generated);
  await compareExampleTrees(generated, deliveryDirectory);
  const args = [
    'landed-delivery',
    'run',
    '--assets',
    resolve(generated, 'assets'),
    '--in',
    resolve(generated, 'inputs/landed-delivery.json'),
    '--now',
    DELIVERY_NOW,
    '--actor',
    DELIVERY_ACTOR,
  ];
  await runExampleCli(workflow, [...args, '--out-dir', resolve(scratch, 'pending')], {
    cwd: root,
    expectedExit: 2,
  });
  await runExampleCli(
    workflow,
    [
      ...args,
      '--approvals',
      resolve(generated, 'approvals/landed-delivery.json'),
      '--out-dir',
      resolve(scratch, 'approved'),
      '--record',
    ],
    { cwd: root, expectedExit: 0 },
  );
  const artifact = JSON.parse(await readFile(resolve(scratch, 'approved/artifact.json'), 'utf8'));
  assert.deepEqual(
    artifact,
    JSON.parse(await readFile(resolve(deliveryDirectory, 'expected/delivery-plan.json'), 'utf8')),
  );
  // 独立核对关键值，避免生成器与流程共同掩盖错误。
  assert.equal(artifact.body.shipments.length, 4);
  assert.equal(artifact.body.arrivals.length, 5);
  assert.equal(artifact.body.held[0].reason, 'compliance_deny');
  assert.equal(artifact.body.fitoutGoodsLastAt.date, '2026-01-19');
  assert.equal(artifact.body.allReceived, false);
  assert.deepEqual(
    artifact.body.shipments
      .filter((shipment) => shipment.freight)
      .map((shipment) => shipment.freight.amount),
    [200, 200],
  );
  const verifications = (await readFile(resolve(generated, 'assets/_verifications.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const dimension of ['access', 'rate', 'carton.grossWeightKg', 'transitDays'])
    assert(
      verifications.some(
        (verification) => verification.dimension === dimension && verification.verdict === 'fails',
      ),
      `Missing negative evidence: ${dimension}`,
    );
  console.log(
    'Delivery example passed: reproducible fixture, approval gates, CLI golden and measured failures',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await checkDeliveryExample();
