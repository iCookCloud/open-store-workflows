import { Lang, defineSlot, z } from '@osw/core';
export const ExamQuestion = z.object({
  no: z.number().int().positive(),
  points: z.number().nonnegative(),
  manual: z.boolean(),
  prompt: z.string().optional(),
  answer: z.string().meta({ writeOnly: true }).optional(),
  rationale: z.string().meta({ writeOnly: true }).optional(),
  guide: z.string().meta({ writeOnly: true }).optional(),
});
export const Exam = z.object({
  key: z.string().min(1),
  certKey: z.string().min(1),
  lang: Lang,
  version: z.string().min(1),
  passScore: z.number().min(0).max(100),
  questions: z.array(ExamQuestion).min(1),
});
export const ExamSlot = defineSlot({
  name: 'exam',
  schema: Exam,
  filterable: { key: ['eq', 'in'], certKey: ['eq', 'in'], lang: ['eq', 'in'] },
  sortable: ['key', 'lang'],
  validate: (value) => {
    if (new Set(value.questions.map((q) => q.no)).size !== value.questions.length)
      throw new Error('Question numbers must be unique');
    if (value.questions.reduce((sum, q) => sum + q.points, 0) <= 0)
      throw new Error('Exam must have positive total points');
  },
});
