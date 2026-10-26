import { readFile } from 'node:fs/promises';
import { ArtifactEnvelope, OpeningRecordBody, SHARED_SLOTS, versionHash } from '@osw/core';
import { FileSource, executeWorkflow } from '@osw/core/node';
import { describe, expect, it } from 'vitest';
import { workflow } from '../src/index.js';
const directory = new URL('../../../examples/sample-store/', import.meta.url).pathname;
const now = '2026-01-01T00:00:00Z';
async function fixture() {
  const input = JSON.parse(await readFile(`${directory}/inputs/opening.json`, 'utf8'));
  const approvals = JSON.parse(await readFile(`${directory}/approvals/opening.json`, 'utf8'));
  const source = await FileSource.open(`${directory}/assets`, [...SHARED_SLOTS, ...workflow.slots]);
  return { input, options: { source, approvals, now, actor: 'example:reviewer' } };
}
describe('opening workflow integration', () => {
  it('executes real assessments, blocks without release, then produces the golden operating handoff', async () => {
    const { input, options } = await fixture();
    const pending = await executeWorkflow(workflow, input, { ...options, approvals: [] });
    expect(pending.exitCode).toBe(2);
    expect(pending.result.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', step: 'opening/signRelease' }),
    );
    const execution = await executeWorkflow(workflow, input, options);
    expect(execution.exitCode, JSON.stringify(execution.result.needs)).toBe(0);
    const artifact = ArtifactEnvelope('OpeningRecord', OpeningRecordBody).parse(
      execution.result.artifact,
    );
    expect(artifact.body.certMatrix.summary).toMatchObject({
      certRequired: 4,
      criticalPassed: 4,
      ready: true,
    });
    expect(artifact.body.certMatrix.cells.every((cell) => cell.attempts > 0 && cell.examiner)).toBe(
      true,
    );
    expect(artifact.body.handoff).toEqual({ storeStatus: 'operating', openedAt: '2026-01-01' });
    expect(artifact.hash).toBe(await versionHash(artifact.body));
    expect(artifact).toEqual(
      JSON.parse(await readFile(`${directory}/expected/opening-record.json`, 'utf8')),
    );
    expect(artifact.example).toBe(true);
    expect(
      Object.values(execution.result.steps).flatMap((step) => step.verifications),
    ).toContainEqual(expect.objectContaining({ purpose: 'opening/applyExam', verdict: 'fails' }));
  });
  it('does not let stale hashes, another store or missing upstream fields bypass structured needs', async () => {
    const { input, options } = await fixture();
    input.storeSpec.body.timezone = '';
    expect((await executeWorkflow(workflow, input, options)).result.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', blocking: true }),
    );
    input.storeSpec.body.timezone = 'UTC';
    input.storeSpec.hash = 'f'.repeat(64);
    expect((await executeWorkflow(workflow, input, options)).result.needs).toContainEqual(
      expect.objectContaining({ path: 'storeSpec.hash' }),
    );
  });
  it('continues a live record with frozen release and preserves first handoff', async () => {
    const { input, options } = await fixture();
    const first = await executeWorkflow(workflow, input, options);
    const previous = first.result.artifact as any;
    const continued = await executeWorkflow(
      workflow,
      {
        ...input,
        previous,
        assessments: [],
        examHistory: [],
        transitions: ['stabilizing'],
        handoff: false,
        issues: [
          {
            id: 'new-p0',
            area: 'equipment',
            severity: 'P0',
            status: 'open',
            refs: [],
            openedOn: '2026-01-01',
          },
        ],
      },
      { ...options, approvals: [] },
    );
    expect(continued.exitCode, JSON.stringify(continued.result.needs)).toBe(0);
    const artifact = continued.result.artifact as any;
    expect(artifact.body.release.current.state).toBe('blocked');
    expect(artifact.body.release.signed).toEqual(previous.body.release.signed);
    expect(artifact.body.handoff).toEqual(previous.body.handoff);
  });
});

it('requires fresh certification when its catalog source changes before opening', async () => {
  const { CertSlot } = await import('../src/training/index.js');
  const { input, options } = await fixture();
  const first = await executeWorkflow(
    workflow,
    { ...input, transitions: ['ready'], handoff: false },
    options,
  );
  expect(first.exitCode).toBe(0);
  const cert = await options.source.get(CertSlot, 'example-safety');
  if (!cert) throw new Error('Missing synthetic certification');
  const data = { ...cert.data, title: { en: 'Updated example standard' } };
  options.source.add({ ...cert, data, versionHash: await versionHash(data) });
  const rerun = await executeWorkflow(
    workflow,
    {
      ...input,
      previous: first.result.artifact,
      assessments: [],
      transitions: ['live'],
      handoff: false,
    },
    options,
  );
  expect(rerun.exitCode).toBe(2);
  expect(rerun.result.steps['opening/evaluateRelease'].output).toMatchObject({
    state: 'blocked',
    blockers: expect.arrayContaining([
      expect.objectContaining({ kind: 'criticalCert', waivable: false }),
    ]),
  });
});
