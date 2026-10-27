import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySource, SHARED_SLOTS } from '@osw/core';
import {
  compareExampleTrees,
  exampleScratch,
  readExampleJson,
  runExampleCli,
} from '@osw/core/node';
import { workflow } from '@osw/opening';
import { ACTOR, NOW, exampleDirectory, generateExamples } from './generate-examples.mjs';

const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const scratch = await exampleScratch('opening');
const generated = join(scratch, 'generated');
const { records } = await generateExamples(generated);
await compareExampleTrees(generated, exampleDirectory);
const args = [
  'opening',
  'run',
  '--assets',
  join(generated, 'assets'),
  '--in',
  join(generated, 'inputs/opening.json'),
  '--now',
  NOW,
  '--actor',
  ACTOR,
];
const blocked = await runExampleCli(workflow, [...args, '--out-dir', join(scratch, 'blocked')], {
  cwd: packageDirectory,
  expectedExit: 2,
});
assert(
  blocked.result.needs.some(
    (need) => need.kind === 'approval' && need.step === 'opening/signRelease',
  ),
);
const approved = [...args, '--approvals', join(generated, 'approvals/opening.json')];
await runExampleCli(workflow, [...approved, '--out-dir', join(scratch, 'approved')], {
  cwd: packageDirectory,
  expectedExit: 0,
});
const artifact = await readExampleJson(join(scratch, 'approved/artifact.json'));
assert.deepEqual(
  artifact,
  await readExampleJson(join(exampleDirectory, 'expected/opening-record.json')),
);
assert.equal(artifact.body.certMatrix.summary.certRequired, 4);
assert.equal(artifact.body.certMatrix.summary.criticalPassed, 4);
assert.equal(artifact.body.release.current.state, 'ready');
assert.deepEqual(artifact.body.handoff, { storeStatus: 'operating', openedAt: '2026-01-01' });
assert.equal(artifact.body.marketing.assetGap.missing, 1);
// 冻结的上游来源记录仅供版本守卫与验证落账；不需要导入生产方的槽位 schema。
const source = new MemorySource(records, [...SHARED_SLOTS, ...workflow.slots]);
await runExampleCli(workflow, [...approved, '--record', '--out-dir', join(scratch, 'recorded')], {
  cwd: packageDirectory,
  expectedExit: 0,
  source,
});
assert(source.verifications.length > 0);
assert(source.verifications.some((verification) => verification.verdict === 'fails'));
assert(source.fills.some((fill) => fill.field === 'openedAt'));
assert.deepEqual(await readExampleJson(join(scratch, 'recorded/artifact.json')), artifact);
console.log(
  'Opening example passed: JSON handoff, real assessments, approval gates, recorded verification/fills and golden artifact',
);
