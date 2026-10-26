import { AssetRef, IsoDateTime, z } from '@osw/core';
import { AssessmentKind } from '../slots/cert.js';
import { Cell, PlanItem, TrainingScope } from '../training/models.js';
export const ExamAttempt = z.object({
  id: z.string().min(1),
  seatId: z.string().min(1),
  certKey: z.string().min(1),
  kind: AssessmentKind,
  at: IsoDateTime,
  by: z.string().trim().min(1),
  state: z.enum(['passed', 'failed', 'grading']),
  examRef: AssetRef.optional(),
  score: z.number().min(0).max(100).optional(),
  details: z
    .array(
      z.object({
        no: z.number().int().positive(),
        earned: z.number().nonnegative(),
        possible: z.number().nonnegative(),
      }),
    )
    .optional(),
  checks: z
    .array(z.object({ key: z.string(), value: z.enum(['pass', 'fail']).nullable() }))
    .optional(),
});
export const ExamSubmission = z.object({
  id: z.string().min(1),
  kind: AssessmentKind,
  by: z.string().trim().min(1),
  answers: z.record(z.string(), z.string()).default({}),
  manualMarks: z.record(z.string(), z.unknown()).default({}),
  checks: z.record(z.string(), z.enum(['pass', 'fail']).nullable()).default({}),
  examiner: z.string().optional(),
  sopRef: AssetRef.optional(),
});
export const ApplyExamInput = TrainingScope.extend({
  timezone: z.string().min(1),
  seatId: z.string().min(1),
  certKey: z.string().min(1),
  planItem: PlanItem,
  examRef: AssetRef.optional(),
  priorCell: Cell.optional(),
  history: z.array(ExamAttempt),
  submission: ExamSubmission,
});
export const ApplyExamOutput = z.object({
  cell: Cell,
  attempt: ExamAttempt,
  history: z.array(ExamAttempt),
  sources: z.array(AssetRef),
});
export type ExamAttempt = z.infer<typeof ExamAttempt>;
