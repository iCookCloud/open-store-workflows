import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AssetRecord, Param, versionHash, z } from '@osw/core';
import { SiteDecision } from '../src/contracts.js';
import { NOW, defaults, record } from './fixtures.js';
import { sampleFlow } from './flow-fixtures.js';

const directory = 'examples/sample-store/site-search';
const f = await sampleFlow();
const write = process.argv.includes('--write');
const persist = async (path: string, value: unknown) => {
  await mkdir(join(directory, path, '..'), { recursive: true });
  await writeFile(join(directory, path), `${JSON.stringify(value, null, 2)}\n`);
};
if (write) {
  const records = [
    ...f.records,
    ...(await Promise.all(
      Object.entries({ ...defaults, 'site.shortlistMax': 10 }).map(([key, value]) =>
        record('params', `example-${key}`, { key, value }),
      ),
    )),
  ];
  for (const slot of new Set(records.map((r) => r.slot)))
    await persist(`assets/${slot}.json`, {
      $example: 'synthetic',
      items: records.filter((r) => r.slot === slot),
    });
  await persist('input.json', { $example: 'synthetic', ...f.plan });
  await persist('approvals.json', { $example: 'synthetic', items: f.approvals });
  await persist('pending-approvals.json', {
    $example: 'synthetic',
    items: f.approvals.filter((a) => a.step !== 'site-search/signLease'),
  });
  await persist('expected.json', { $example: 'synthetic', artifact: f.output.artifact });
  await persist('receipts.json', {
    $example: 'synthetic',
    items: f.receipts.map((r) => ({
      ...r,
      signedPdf: Array.from(r.signedPdf),
      auditCertificate: Array.from(r.auditCertificate),
    })),
  });
  await persist('places.json', {
    $example: 'synthetic',
    items: Array.from({ length: 3 }, (_, i) => ({
      providerPlaceId: `example-place-${i}`,
      geo: { lat: 0.001 * i, lng: 0 },
    })),
  });
}
const expected = JSON.parse(await readFile(join(directory, 'expected.json'), 'utf8'));
if (SiteDecision.parse(f.output.artifact).hash !== SiteDecision.parse(expected.artifact).hash)
  throw new Error('Synthetic SiteDecision golden hash drifted');
for (const [name, approvals, status] of [
  ['pending', 'pending-approvals.json', 2],
  ['signed', 'approvals.json', 0],
] as const) {
  const outDir = `.osw/site-search-${name}`;
  const args = [
    'packages/core/dist/node/cli.js',
    'site-search',
    'run',
    '--assets',
    `${directory}/assets`,
    '--in',
    `${directory}/input.json`,
    '--approvals',
    `${directory}/${approvals}`,
    '--providers',
    `${directory}/providers.mjs`,
    '--out-dir',
    outDir,
    '--now',
    NOW,
    '--actor',
    'example-test',
  ];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (child.status !== status)
    throw new Error(
      `${name}: expected exit ${status}, got ${child.status}: ${child.stderr}\n${child.stdout}`,
    );
  const output = JSON.parse(await readFile(join(outDir, 'result.json'), 'utf8'));
  if (
    name === 'pending' &&
    !output.needs.some(
      (n: { kind: string; step?: string }) =>
        n.kind === 'approval' && n.step === 'site-search/signLease',
    )
  )
    throw new Error('Missing signLease approval need');
  if (name === 'signed' && SiteDecision.parse(output.artifact).hash !== expected.artifact.hash)
    throw new Error('CLI and library produced different SiteDecision hashes');
}
console.log(
  'site-search example: 8 listings, 10 steps, pending exit 2, signed exit 0, golden hash matched',
);
