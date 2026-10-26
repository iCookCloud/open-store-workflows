import { assetRef } from '@osw/core';
import { describe, expect, it } from 'vitest';
import {
  ApplyExamInput,
  PlanItem,
  addTrainingMonths,
  applyExam,
  certState,
  gradePractical,
  gradeWritten,
  toStudentPaper,
} from '../src/training/index.js';
import {
  activeSeat,
  reference,
  sampleCert,
  sampleExam,
  trainingContext,
  trainingNow,
  trainingRecord,
  trainingScope,
} from './training-fixtures.js';
const item = () => PlanItem.parse({ ...sampleCert(), enabled: true, checks: ['clean', 'serve'] });
const writtenSubmission = {
  id: 'written-one',
  kind: 'written' as const,
  by: 'example:examiner',
  answers: { '1': '  eXaMpLe\nA  ' },
  manualMarks: { '2': 50 },
  checks: {},
};
async function examFixture() {
  const exam = await trainingRecord('exam', 'exam', sampleExam());
  return { exam, ctx: await trainingContext([exam]) };
}
const assessment = (extra: Record<string, unknown> = {}) =>
  ApplyExamInput.parse({
    ...trainingScope,
    seatId: activeSeat.seatId,
    certKey: 'safety',
    planItem: item(),
    history: [],
    submission: writtenSubmission,
    ...extra,
  });

describe('student papers and scoring privacy', () => {
  it('projects only the student-visible question fields', async () => {
    const { exam, ctx } = await examFixture();
    const result = await toStudentPaper.run({ examRef: assetRef(exam) }, ctx);
    expect(result.output?.questions[0]).toEqual({
      no: 1,
      points: 50,
      manual: false,
      prompt: 'Invented question',
    });
    expect(JSON.stringify(result)).not.toMatch(/answer|rationale|guide/);
    expect(toStudentPaper.outputPrivate?.length).toBeGreaterThan(0);
  });
  it('does not disclose the paper through grading output', async () => {
    const { exam, ctx } = await examFixture();
    const result = await applyExam.run(assessment({ examRef: assetRef(exam) }), ctx);
    expect(result.output?.attempt.score).toBe(100);
    expect(result.output?.attempt.details).toEqual([
      { no: 1, earned: 50, possible: 50 },
      { no: 2, earned: 50, possible: 50 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /private rationale|Invented question|Example A|private mark guide/,
    );
    expect(applyExam.outputPrivate?.length).toBeGreaterThan(0);
  });
  it('normalizes whitespace and case, clamps manual marks, and keeps ungraded work grading', () => {
    const exam = sampleExam() as Parameters<typeof gradeWritten>[0];
    expect(gradeWritten(exam, { '1': 'EXAMPLE A' }, { '2': 500 }, 60).score).toBe(100);
    expect(gradeWritten(exam, { '1': 'Example A' }, {}, 60).state).toBe('grading');
    expect(gradeWritten(exam, {}, { '2': -3 }, 60).score).toBe(0);
    expect(gradeWritten(exam, {}, { '2': '50' }, 60).score).toBe(0);
  });
  it('cannot infer a correct blank objective answer when an answer is unavailable', async () => {
    const exam = await trainingRecord(
      'exam',
      'exam',
      sampleExam({ questions: [{ no: 1, points: 100, manual: false }] }),
    );
    const result = await applyExam.run(
      assessment({ examRef: assetRef(exam) }),
      await trainingContext([exam]),
    );
    expect(result.output).toBeNull();
    expect(result.needs.some((n) => n.kind === 'input' && n.reason.includes('answer key'))).toBe(
      true,
    );
  });
});

describe('certification state and attempts', () => {
  it('requires every declared assessment kind and preserves prior practical passes', async () => {
    const { exam, ctx } = await examFixture();
    const first = await applyExam.run(assessment({ examRef: assetRef(exam) }), ctx);
    expect(first.output?.cell.state).toBe('grading');
    const practical = await applyExam.run(
      assessment({
        examRef: undefined,
        history: first.output!.history,
        priorCell: first.output!.cell,
        submission: {
          id: 'practical-one',
          kind: 'practical',
          by: 'example:checker',
          checks: { clean: 'pass', serve: 'pass' },
          examiner: 'example:checker',
        },
      }),
      ctx,
    );
    expect(practical.output?.cell).toMatchObject({
      state: 'passed',
      attempts: 2,
      examiner: 'example:checker',
    });
    const later = await applyExam.run(
      assessment({
        examRef: assetRef(exam),
        history: practical.output!.history,
        priorCell: practical.output!.cell,
        submission: { ...writtenSubmission, id: 'written-two', examiner: '' },
      }),
      { ...ctx, now: '2026-03-02T01:00:00Z' },
    );
    expect(later.output?.cell).toMatchObject({
      state: 'passed',
      attempts: 3,
      examiner: 'example:checker',
    });
  });
  it('fails practical work on any failed column and grades incomplete columns', () => {
    expect(gradePractical(['clean', 'serve'], { clean: 'pass', serve: 'fail' }).state).toBe(
      'failed',
    );
    expect(gradePractical(['clean', 'serve'], { clean: 'pass' }).state).toBe('grading');
    expect(gradePractical([], {}).state).toBe('grading');
  });
  it('uses only the latest attempt of each kind', () => {
    const base = { seatId: 'seat-one', certKey: 'safety', by: 'example', at: trainingNow };
    expect(
      certState(
        ['written', 'practical'],
        [
          { ...base, id: 'a', kind: 'written', state: 'failed' },
          { ...base, id: 'b', kind: 'written', state: 'passed', at: '2026-03-02T00:00:00Z' },
          { ...base, id: 'c', kind: 'practical', state: 'passed' },
        ],
      ),
    ).toBe('passed');
    expect(certState([], [])).toBe('pending');
  });
  it('derives attempts from history and computes recertification by UTC month addition', async () => {
    const { ctx } = await examFixture();
    const result = await applyExam.run(
      assessment({
        planItem: { ...item(), requires: ['practical'], recertMonths: 1 },
        priorCell: {
          seatId: 'seat-one',
          certKey: 'safety',
          critical: true,
          locked: true,
          state: 'pending',
          attempts: 500,
        },
        submission: {
          id: 'practical-one',
          kind: 'practical',
          by: 'example:checker',
          checks: { clean: 'pass', serve: 'pass' },
        },
      }),
      ctx,
    );
    expect(result.output?.cell).toMatchObject({
      attempts: 1,
      passedAt: '2026-03-01',
      recertDue: '2026-04-01',
    });
    expect(addTrainingMonths('2024-01-31', 1)).toBe('2024-03-02');
  });
  it('allows updating an unfinished manual grade without increasing attempt count', async () => {
    const { exam, ctx } = await examFixture();
    const first = await applyExam.run(
      assessment({
        examRef: assetRef(exam),
        submission: { ...writtenSubmission, manualMarks: {} },
      }),
      ctx,
    );
    expect(first.output?.attempt.state).toBe('grading');
    const final = await applyExam.run(
      assessment({
        examRef: assetRef(exam),
        history: first.output!.history,
        priorCell: first.output!.cell,
      }),
      ctx,
    );
    expect(final.output?.attempt.state).toBe('passed');
    expect(final.output?.cell.attempts).toBe(1);
  });
  it('rejects rewriting a completed attempt and future history', async () => {
    const { exam, ctx } = await examFixture();
    const first = await applyExam.run(assessment({ examRef: assetRef(exam) }), ctx);
    expect(
      (
        await applyExam.run(
          assessment({ examRef: assetRef(exam), history: first.output!.history }),
          ctx,
        )
      ).output,
    ).toBeNull();
    expect(
      (
        await applyExam.run(
          assessment({
            examRef: assetRef(exam),
            history: [{ ...first.output!.attempt, id: 'future', at: '2030-01-01T00:00:00Z' }],
          }),
          ctx,
        )
      ).output,
    ).toBeNull();
  });
  it('emits pending below the configured verification sample and fails a nondiscriminating paper', async () => {
    const { exam, ctx } = await examFixture();
    const first = await applyExam.run(assessment({ examRef: assetRef(exam) }), ctx);
    expect(first.verifications[0].verdict).toBe('pending');
    const second = await applyExam.run(
      assessment({
        seatId: 'seat-two',
        examRef: assetRef(exam),
        history: first.output!.history,
        submission: { ...writtenSubmission, id: 'written-two' },
      }),
      ctx,
    );
    expect(second.verifications[0].verdict).toBe('fails');
    expect(second.verifications[0].measured?.actual).toBe(1);
  });
  it('raises the effective passing score to the configured floor', async () => {
    const { exam } = await examFixture();
    const ctx = await trainingContext([exam], {
      'training.minPassScore': 90,
      'training.verify.minAttempts': 1,
      'training.verify.firstPassRateLow': 0,
      'training.verify.firstPassRateHigh': 1,
    });
    const result = await applyExam.run(
      assessment({
        examRef: assetRef(exam),
        submission: { ...writtenSubmission, manualMarks: { '2': 20 } },
      }),
      ctx,
    );
    expect(result.output?.attempt).toMatchObject({ score: 70, state: 'failed' });
  });
});

describe('course unit assessment', () => {
  it('grades the derived course controls and retains the exact SOP source reference', async () => {
    const { deriveCertMatrix } = await import('../src/training/derive-cert-matrix.js');
    const { sampleRole, sampleCourse, plannedStaffing } = await import('./training-fixtures.js');
    const course = await trainingRecord('course', 'course', sampleCourse());
    const role = await trainingRecord('role', 'cook', sampleRole());
    const ctx = await trainingContext([course, role]);
    const matrix = await deriveCertMatrix.run(
      {
        ...trainingScope,
        staffing: plannedStaffing,
        seats: [activeSeat],
        openStations: ['hot'],
        plan: reference(),
        planItems: [item()],
        cells: [],
      },
      ctx,
    );
    const unit = matrix.output!.courseItems[0];
    const result = await applyExam.run(
      assessment({
        certKey: unit.key,
        planItem: unit,
        submission: {
          id: 'sop-observation',
          kind: 'practical',
          by: 'example:observer',
          checks: { observe: 'pass' },
        },
      }),
      ctx,
    );
    expect(result.output?.cell).toMatchObject({
      state: 'passed',
      examiner: 'example:observer',
      sop: { ...assetRef(course), path: '/units/0' },
    });
    expect(result.output?.sources).toContainEqual({ ...assetRef(course), path: '/units/0' });
  });
  it('rejects empty or changed practical checks instead of issuing a course pass', async () => {
    const { sampleCourse } = await import('./training-fixtures.js');
    const course = await trainingRecord('course', 'course', sampleCourse());
    const unit = {
      ...item(),
      key: 'course:course:hot-sop',
      ref: { ...assetRef(course), path: '/units/0' },
      locked: false,
      requires: ['practical'],
      checks: [],
    };
    const result = await applyExam.run(
      assessment({
        certKey: unit.key,
        planItem: unit,
        submission: {
          id: 'sop-observation',
          kind: 'practical',
          by: 'example:observer',
          checks: {},
        },
      }),
      await trainingContext([course]),
    );
    expect(result.output).toBeNull();
  });
});
