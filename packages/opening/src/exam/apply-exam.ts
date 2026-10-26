import { type Need, type StepDef, assetRef, todayIn } from '@osw/core';
import { CertSlot } from '../slots/cert.js';
import { CourseSlot } from '../slots/course.js';
import { ExamSlot } from '../slots/exam.js';
import {
  inputNeed,
  numericTrainingParam,
  parseInput,
  readTrainingRef,
  trainingResult,
  trainingVerification,
  uniqueTrainingRefs,
} from '../training/helpers.js';
import { addTrainingMonths, certState } from './cert-state.js';
import { gradePractical, gradeWritten } from './grade.js';
import { ApplyExamInput, ApplyExamOutput, type ExamAttempt } from './models.js';
export const applyExam: StepDef<typeof ApplyExamInput, typeof ApplyExamOutput> = {
  id: 'opening/applyExam',
  input: ApplyExamInput,
  output: ApplyExamOutput,
  reads: ['exam', 'cert', 'course', 'params'],
  params: [
    {
      key: 'training.minPassScore',
      required: true,
      description: 'Minimum exam passing score',
      unit: 'percent',
    },
    {
      key: 'training.verify.minAttempts',
      required: true,
      description: 'Minimum first-attempt sample count',
    },
    {
      key: 'training.verify.firstPassRateLow',
      required: true,
      description: 'Minimum accepted first pass rate',
      unit: 'ratio',
    },
    {
      key: 'training.verify.firstPassRateHigh',
      required: true,
      description: 'Maximum accepted first pass rate',
      unit: 'ratio',
    },
  ],
  outputPrivate: ['/answer', '/rationale', '/guide', '/questions', '/source'],
  async run(raw, ctx) {
    const parsed = parseInput(ApplyExamInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    let today: string;
    try {
      today = todayIn(input.timezone, ctx.now);
    } catch {
      return trainingResult(null, [inputNeed('timezone', 'A valid IANA timezone is required')]);
    }
    const minimum = numericTrainingParam(ctx, 'training.minPassScore', input, needs, 0, 100);
    const minAttempts = numericTrainingParam(ctx, 'training.verify.minAttempts', input, needs, 1);
    const low = numericTrainingParam(ctx, 'training.verify.firstPassRateLow', input, needs, 0, 1);
    const high = numericTrainingParam(ctx, 'training.verify.firstPassRateHigh', input, needs, 0, 1);
    if (minAttempts !== null && !Number.isInteger(minAttempts))
      needs.push(inputNeed('training.verify.minAttempts', 'Sample count must be an integer'));
    if (low !== null && high !== null && low > high)
      needs.push(inputNeed('training.verify', 'First pass rate interval is inverted'));
    if (input.planItem.key !== input.certKey || !input.planItem.enabled)
      needs.push(inputNeed('planItem', 'Assessment must target an enabled matching plan item'));
    if (
      input.priorCell &&
      (input.priorCell.seatId !== input.seatId || input.priorCell.certKey !== input.certKey)
    )
      needs.push(inputNeed('priorCell', 'Prior cell belongs to a different seat or certification'));
    if (new Set(input.history.map((a) => a.id)).size !== input.history.length)
      needs.push(inputNeed('history', 'Attempt ids must be unique'));
    if (input.history.some((a) => Date.parse(a.at) > Date.parse(ctx.now)))
      needs.push(inputNeed('history', 'Future assessment records cannot establish certification'));
    const oldAttempt = input.history.find((a) => a.id === input.submission.id);
    if (
      oldAttempt &&
      (oldAttempt.state !== 'grading' ||
        oldAttempt.seatId !== input.seatId ||
        oldAttempt.certKey !== input.certKey ||
        oldAttempt.kind !== input.submission.kind)
    )
      needs.push(
        inputNeed('submission.id', 'Only an existing matching grading attempt may be updated'),
      );
    const refs = [];
    if (input.planItem.ref?.slot === 'course') {
      const course = await readTrainingRef(ctx, CourseSlot, input.planItem.ref, needs);
      const unit = course?.data.units.find(
        (unit, index) => input.planItem.ref?.path === `/units/${index}`,
      );
      if (
        !unit ||
        input.planItem.key !== `course:${course?.id}:${unit.id}` ||
        input.planItem.requires.length !== 1 ||
        input.planItem.requires[0] !== 'practical' ||
        JSON.stringify(input.planItem.checks) !== JSON.stringify(unit.controls)
      )
        needs.push(
          inputNeed('planItem', 'Course assessment must preserve its source unit and controls'),
        );
      if (course) refs.push(input.planItem.ref);
    } else if (input.planItem.ref?.slot === 'cert') {
      const cert = await readTrainingRef(ctx, CertSlot, input.planItem.ref, needs);
      if (
        cert &&
        (cert.data.key !== input.certKey ||
          (cert.data.locked &&
            (!input.planItem.locked ||
              input.planItem.critical !== cert.data.critical ||
              JSON.stringify(input.planItem.requires) !== JSON.stringify(cert.data.requires))))
      )
        needs.push(
          inputNeed('planItem', 'Locked catalog assessment requirements cannot be weakened'),
        );
      if (cert) refs.push(input.planItem.ref);
    }

    if (needs.some((need) => need.blocking)) return trainingResult(null, needs);
    let graded: Pick<ExamAttempt, 'state' | 'score' | 'details' | 'checks'>;
    if (input.submission.kind === 'practical') {
      if (!input.planItem.checks.length)
        needs.push(
          inputNeed('planItem.checks', 'Practical assessment requires explicit check columns'),
        );
      graded = gradePractical(input.planItem.checks, input.submission.checks);
    } else {
      if (!input.examRef)
        return trainingResult(null, [
          ...needs,
          inputNeed('examRef', 'Written or scenario assessment requires an exam reference'),
        ]);
      const exam = await readTrainingRef(ctx, ExamSlot, input.examRef, needs);
      if (!exam) return trainingResult(null, needs);
      if (exam.data.certKey !== input.certKey)
        needs.push(inputNeed('examRef', 'Exam targets a different certification'));
      if (exam.data.questions.some((q) => !q.manual && q.answer === undefined))
        needs.push(inputNeed('examRef', 'Objective answer key is unavailable to this runner'));
      if (
        input.planItem.passScore !== undefined &&
        minimum !== null &&
        input.planItem.passScore < minimum
      )
        needs.push(
          inputNeed('planItem.passScore', 'Plan passing score is below the configured minimum'),
        );
      graded = gradeWritten(
        exam.data,
        input.submission.answers,
        input.submission.manualMarks,
        Math.max(input.planItem.passScore ?? exam.data.passScore, minimum ?? 0),
      );
      refs.push(assetRef(exam));
    }
    if (needs.some((need) => need.blocking)) return trainingResult(null, needs);
    const attempt: ExamAttempt = {
      id: input.submission.id,
      seatId: input.seatId,
      certKey: input.certKey,
      kind: input.submission.kind,
      at: oldAttempt?.at ?? ctx.now,
      by: input.submission.by,
      ...graded,
      ...(input.examRef ? { examRef: input.examRef } : {}),
    };
    const history = [...input.history.filter((a) => a.id !== attempt.id), attempt];
    const relevant = history.filter(
      (a) => a.seatId === input.seatId && a.certKey === input.certKey,
    );
    const state = certState(input.planItem.requires, relevant);
    const cell = {
      ...input.priorCell,
      seatId: input.seatId,
      certKey: input.certKey,
      critical: input.planItem.critical,
      locked: input.planItem.locked,
      state,
      attempts: relevant.length,
      examiner:
        input.submission.examiner?.trim() || input.priorCell?.examiner || input.submission.by,
      ...(input.submission.sopRef
        ? { sop: input.submission.sopRef }
        : input.planItem.ref?.slot === 'course'
          ? { sop: input.planItem.ref }
          : {}),
      ...(state === 'passed'
        ? {
            passedAt: today,
            ...(input.planItem.recertMonths
              ? { recertDue: addTrainingMonths(today, input.planItem.recertMonths) }
              : {}),
          }
        : {}),
    };
    const verifications = [];
    if (input.examRef) {
      const first = new Map<string, ExamAttempt>();
      for (const row of history.filter(
        (a) =>
          a.examRef?.id === input.examRef?.id &&
          a.examRef?.versionHash === input.examRef?.versionHash,
      )) {
        const key = JSON.stringify([row.seatId, row.certKey, row.kind]);
        if (!first.has(key) || Date.parse(first.get(key)!.at) > Date.parse(row.at))
          first.set(key, row);
      }
      const final = [...first.values()].filter((a) => a.state !== 'grading');
      const rate = final.length
        ? final.filter((a) => a.state === 'passed').length / final.length
        : 0;
      verifications.push(
        trainingVerification(
          input.examRef,
          'opening/applyExam',
          minAttempts === null || final.length < minAttempts
            ? 'pending'
            : low !== null && high !== null && rate >= low && rate <= high
              ? 'holds'
              : 'fails',
          'firstPassRate',
          'First-attempt outcomes assess exam discrimination',
          ctx,
          { measured: { field: 'firstPassRate', expected: null, actual: rate, unit: 'ratio' } },
        ),
      );
    }
    const paramKeys = applyExam.params.map((p) => p.key);
    return trainingResult(
      {
        cell,
        attempt,
        history,
        sources: uniqueTrainingRefs([
          ...refs,
          ...history.flatMap((row) => (row.examRef ? [row.examRef] : [])),
          ...(input.planItem.ref ? [input.planItem.ref] : []),
          ...paramKeys.flatMap((key) => ctx.params.refs?.(key, input) ?? []),
        ]),
      },
      needs,
      verifications,
    );
  },
};
