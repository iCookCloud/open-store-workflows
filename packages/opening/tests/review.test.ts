import { readFile } from 'node:fs/promises';
import { MemorySource, SHARED_SLOTS, assetRef, versionHash } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { review } from '../src/lifecycle/review.js';
import { CourseSlot } from '../src/slots/course.js';
import { context, now, record } from './lifecycle-fixtures.js';
const usd = (amount: number) => ({ amount, currency: 'USD' });
async function fixture() {
  const storeSpec = JSON.parse(
    await readFile(
      new URL('../../../examples/sample-store/expected/store-spec.json', import.meta.url),
      'utf8',
    ),
  );
  const courseData = {
    key: 'example-course',
    rights: 'synthetic',
    version: '1',
    sourceDocs: [],
    units: [
      {
        id: 'sop',
        title: 'Example SOP',
        station: 'hot',
        positions: ['cook'],
        critical: true,
        controls: ['check'],
        covers: ['dish'],
      },
    ],
  };
  const course = {
    slot: 'course',
    id: 'example-course',
    slotVersion: '0.1.0',
    versionHash: await versionHash(courseData),
    updatedAt: now,
    coverage: { tier: 'general' as const, tracks: [], workflows: [], jurisdictions: [] },
    data: courseData,
  };
  const opening = await record();
  opening.sources = [assetRef(course)];
  opening.body.certMatrix.cells[0].sop = assetRef(course, undefined, '/units/0');
  opening.hash = await versionHash(opening.body);
  const input = {
    record: opening,
    storeSpec,
    templateItems: [
      {
        key: 'permit',
        title: 'Example Permit',
        phase: 'before',
        dayOffset: -1,
        gate: true,
        waivable: false,
        reviewCheckpoint: 'month',
      },
    ],
    complaintAreas: ['service'],
    observations: [
      {
        checkpoint: 'month',
        period: 'openingMonth' as const,
        orders: 0,
        revenue: usd(0),
        labor: null,
        foodCost: null,
        waste: null,
        costActions: [],
        lessons: [],
      },
    ],
  };
  return {
    input,
    ctx: { ...context(), assets: new MemorySource([course], [...SHARED_SLOTS, CourseSlot]) },
    course,
  };
}
describe('opening review evidence', () => {
  it('keeps zero-order ticket and missing prime cost null; review approval is nonblocking', async () => {
    const { input, ctx } = await fixture();
    const result = await review.run(input, ctx);
    expect(result.output?.reviews[0].kpis.averageTicket).toBeNull();
    expect(result.output?.reviews[0].kpis.primeCostRate).toBeNull();
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', blocking: false }),
    );
    expect(result.verifications.find((v) => v.dimension === 'breakeven')?.verdict).toBe('pending');
  });
  it('signs exact review content and invalidates approval when observed figures change', async () => {
    const { input, ctx } = await fixture();
    input.observations[0].orders = 10;
    input.observations[0].revenue = usd(200);
    const pending = await review.run(input, ctx);
    const gate = pending.needs.find((need) => need.kind === 'approval')!;
    if (gate.kind !== 'approval') throw new Error('Missing review gate');
    const approved = {
      ...ctx,
      approvals: [
        {
          step: gate.step,
          subject: gate.subject,
          subjectHash: gate.subjectHash,
          decision: 'signed',
          at: now,
          by: 'example:reviewer',
        },
      ],
    };
    const result = await review.run(input, approved);
    expect(result.output?.reviews[0].signedAt).toBe(now);
    expect(result.output?.reviews[0].kpis.averageTicket).toEqual(usd(20));
    input.observations[0].orders = 20;
    expect((await review.run(input, approved)).output?.reviews[0].signedAt).toBeNull();
  });
  it('records a failed SOP when an issue points to its unit, including a closed issue', async () => {
    const { input, ctx, course } = await fixture();
    input.record.body.issues.push({
      id: 'issue',
      area: 'service',
      severity: 'P1',
      status: 'closed',
      openedOn: '2026-02-28',
      closedOn: '2026-03-01',
      verificationNote: 'Resolved',
      refs: [assetRef(course, undefined, '/units/0')],
    });
    input.record.hash = await versionHash(input.record.body);
    const result = await review.run(input, ctx);
    expect(result.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'sopQuality', verdict: 'fails', evidence: ['issue'] }),
    );
  });
  it('does not invent successful quality verification without opening-month observations', async () => {
    const { input, ctx } = await fixture();
    const result = await review.run({ ...input, observations: [] }, ctx);
    expect(result.verifications).toEqual([]);
    expect(result.output?.reviews).toEqual([]);
  });
});
