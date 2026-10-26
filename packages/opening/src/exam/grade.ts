import type { z } from '@osw/core';
import type { Exam } from '../slots/exam.js';
export const normalizeAnswer = (value: string) => value.replace(/\s/gu, '').toLocaleLowerCase('en');
export function gradeWritten(
  exam: z.infer<typeof Exam>,
  answers: Record<string, string>,
  marks: Record<string, unknown>,
  passScore: number,
) {
  let ungraded = false;
  const details = exam.questions.map((question) => {
    let earned: number;
    if (question.manual) {
      if (!Object.hasOwn(marks, String(question.no))) ungraded = true;
      const value = marks[String(question.no)];
      earned =
        typeof value === 'number' && Number.isFinite(value)
          ? Math.max(0, Math.min(question.points, value))
          : 0;
    } else
      earned =
        question.answer !== undefined &&
        normalizeAnswer(answers[String(question.no)] ?? '') === normalizeAnswer(question.answer)
          ? question.points
          : 0;
    return { no: question.no, earned, possible: question.points };
  });
  const possible = details.reduce((sum, item) => sum + item.possible, 0);
  const score =
    possible > 0 ? (details.reduce((sum, item) => sum + item.earned, 0) / possible) * 100 : 0;
  return {
    details,
    score,
    state: ungraded
      ? ('grading' as const)
      : score >= passScore
        ? ('passed' as const)
        : ('failed' as const),
  };
}
export function gradePractical(
  keys: readonly string[],
  answers: Record<string, 'pass' | 'fail' | null>,
) {
  const checks = keys.map((key) => ({ key, value: answers[key] ?? null }));
  const state = checks.some((item) => item.value === 'fail')
    ? ('failed' as const)
    : !checks.length || checks.some((item) => item.value === null)
      ? ('grading' as const)
      : ('passed' as const);
  return { checks, state };
}
