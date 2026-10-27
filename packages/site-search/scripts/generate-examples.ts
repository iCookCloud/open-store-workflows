import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExampleJson } from '@osw/core/node';
import { defaults, record } from '../tests/fixtures.js';
import { sampleFlow } from '../tests/flow-fixtures.js';

export const exampleDirectory = fileURLToPath(new URL('../examples/', import.meta.url));
export async function generateSiteExamples(directory = exampleDirectory) {
  const f = await sampleFlow();
  const persist = (path: string, value: unknown) => writeExampleJson(join(directory, path), value);
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
  if (resolve(directory) !== resolve(exampleDirectory)) {
    await mkdir(directory, { recursive: true });
    await copyFile(join(exampleDirectory, 'providers.mjs'), join(directory, 'providers.mjs'));
  }
  return f;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateSiteExamples(process.argv[2] ? resolve(process.argv[2]) : exampleDirectory);
}
