import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELIVERY_ACTOR,
  DELIVERY_NOW,
  deliveryDirectory,
  generateDeliveryExample,
} from './gen-delivery-example.mjs';

export async function checkDeliveryExample() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(resolve(root, '.osw'), { recursive: true });
  const scratch = await mkdtemp(resolve(root, '.osw/delivery-example-'));
  const generated = resolve(scratch, 'generated');
  await generateDeliveryExample(generated);
  async function compare(path = '') {
    for (const entry of await readdir(resolve(generated, path), { withFileTypes: true })) {
      const relativePath = [path, entry.name].filter(Boolean).join('/');
      if (entry.isDirectory()) await compare(relativePath);
      else
        assert.equal(
          await readFile(resolve(generated, relativePath), 'utf8'),
          await readFile(resolve(deliveryDirectory, relativePath), 'utf8'),
          `Delivery golden changed: ${relativePath}`,
        );
    }
  }
  await compare();
  const args = [
    resolve(root, 'packages/core/dist/node/cli.js'),
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
  const pending = spawnSync(process.execPath, [...args, '--out-dir', resolve(scratch, 'pending')], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(pending.status, 2, `Missing delivery approvals must block: ${pending.stderr}`);
  const approved = spawnSync(
    process.execPath,
    [
      ...args,
      '--approvals',
      resolve(generated, 'approvals/landed-delivery.json'),
      '--out-dir',
      resolve(scratch, 'approved'),
      '--record',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(
    approved.status,
    0,
    `Approved delivery CLI failed: ${approved.stderr}\n${approved.stdout}`,
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
