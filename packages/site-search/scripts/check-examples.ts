import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareExampleTrees, runExampleCli } from '@osw/core/node';
import { workflow } from '@osw/site-search';
import { SiteDecision } from '../src/contracts.js';
import { NOW } from '../tests/fixtures.js';
import { exampleDirectory, generateSiteExamples } from './generate-examples.js';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(packageDirectory, '.osw'), { recursive: true });
const scratch = await mkdtemp(join(packageDirectory, '.osw/site-example-'));
const generated = join(scratch, 'generated');
const f = await generateSiteExamples(generated);
await compareExampleTrees(generated, exampleDirectory);
const savedListings = JSON.parse(
  await readFile(join(generated, 'assets/listing.json'), 'utf8'),
).items;
assert.equal(savedListings.length, 8);
const expected = JSON.parse(await readFile(join(exampleDirectory, 'expected.json'), 'utf8'));
assert.equal(
  SiteDecision.parse(f.output.artifact).hash,
  SiteDecision.parse(expected.artifact).hash,
);
for (const [name, approvals, expectedExit] of [
  ['pending', 'pending-approvals.json', 2],
  ['signed', 'approvals.json', 0],
] as const) {
  const outDir = join(scratch, name);
  const { result } = await runExampleCli(
    workflow,
    [
      'site-search',
      'run',
      '--assets',
      join(generated, 'assets'),
      '--in',
      join(generated, 'input.json'),
      '--approvals',
      join(generated, approvals),
      '--providers',
      join(generated, 'providers.mjs'),
      '--out-dir',
      outDir,
      '--now',
      NOW,
      '--actor',
      'example-test',
    ],
    { cwd: packageDirectory, expectedExit },
  );
  if (name === 'pending')
    assert(
      result.needs.some(
        (need: { kind: string; step?: string }) =>
          need.kind === 'approval' && need.step === 'site-search/signLease',
      ),
    );
  if (name === 'signed')
    assert.equal(SiteDecision.parse(result.artifact).hash, expected.artifact.hash);
}
console.log(
  'site-search example: 8 listings, 10 steps, pending exit 2, signed exit 0, golden hash matched',
);
