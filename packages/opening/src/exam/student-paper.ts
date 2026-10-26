import { AssetRef, type Need, type StepDef, assetRef, z } from '@osw/core';
import { ExamSlot } from '../slots/exam.js';
import { parseInput, readTrainingRef, trainingResult } from '../training/helpers.js';
export const StudentPaperInput = z.object({ examRef: AssetRef });
export const StudentPaperOutput = z.object({
  ref: AssetRef,
  key: z.string(),
  certKey: z.string(),
  lang: z.string(),
  version: z.string(),
  passScore: z.number(),
  questions: z.array(
    z.object({
      no: z.number().int(),
      points: z.number(),
      manual: z.boolean(),
      prompt: z.string().optional(),
    }),
  ),
});
export const toStudentPaper: StepDef<typeof StudentPaperInput, typeof StudentPaperOutput> = {
  id: 'opening/toStudentPaper',
  input: StudentPaperInput,
  output: StudentPaperOutput,
  reads: ['exam'],
  params: [],
  outputPrivate: ['/answer', '/rationale', '/guide', '/source'],
  async run(raw, ctx) {
    const parsed = parseInput(StudentPaperInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const needs: Need[] = [];
    const record = await readTrainingRef(ctx, ExamSlot, parsed.value.examRef, needs);
    if (!record) return trainingResult(null, needs);
    // 白名单投影，题库日后增加私密字段也不会自动进入学生卷。
    const { key, certKey, lang, version, passScore } = record.data;
    const questions = record.data.questions.map(({ no, points, manual, prompt }) => ({
      no,
      points,
      manual,
      ...(prompt ? { prompt } : {}),
    }));
    return trainingResult(
      { ref: assetRef(record), key, certKey, lang, version, passScore, questions },
      needs,
    );
  },
};
