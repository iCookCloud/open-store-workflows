import type { z } from '@osw/core';
import type { AssessmentKind } from '../slots/cert.js';
import type { ExamAttempt } from './models.js';
export function certState(
  required: readonly z.infer<typeof AssessmentKind>[],
  history: readonly ExamAttempt[],
): 'pending' | 'grading' | 'passed' | 'failed' {
  const latest = new Map<string, ExamAttempt>();
  for (const attempt of history)
    if (
      !latest.has(attempt.kind) ||
      Date.parse(latest.get(attempt.kind)!.at) <= Date.parse(attempt.at)
    )
      latest.set(attempt.kind, attempt);
  const kinds = required.length ? required : [...latest.keys()];
  if (!latest.size || !kinds.length) return 'pending';
  if (kinds.some((kind) => latest.get(kind)?.state === 'failed')) return 'failed';
  if (kinds.some((kind) => latest.get(kind)?.state !== 'passed')) return 'grading';
  return 'passed';
}
export function addTrainingMonths(date: string, months: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}
