import {
  AssetRef,
  type Coverage,
  Lang,
  type Need,
  type StepDef,
  TrackKey,
  assetRef,
  z,
} from '@osw/core';
import { CourseSlot } from '../slots/course.js';
import { ExamSlot } from '../slots/exam.js';
import { TrackAffinitySlot } from '../slots/track-affinity.js';
import { inputNeed, parseInput, trainingQuery, trainingResult } from './helpers.js';
export const PickMaterialsInput = z.object({
  track: TrackKey,
  certKeys: z.array(z.string()).min(1),
  langs: z.array(Lang).min(1),
});
const Material = z.object({
  ref: AssetRef,
  rank: z.number().int(),
  borrowedFrom: TrackKey.nullable(),
  certKey: z.string().optional(),
  lang: Lang.optional(),
});
export const PickMaterialsOutput = z.object({
  papers: z.array(Material),
  courses: z.array(Material),
  sources: z.array(AssetRef),
});
export function materialRank(coverage: Coverage, track: string, borrowFrom: readonly string[]) {
  if (coverage.tier === 'track' && coverage.tracks.includes(track)) return 0;
  if (coverage.tier === 'general') return 1;
  if (coverage.tracks.some((t) => borrowFrom.includes(t))) return 2;
  return 3;
}
export const pickMaterials: StepDef<typeof PickMaterialsInput, typeof PickMaterialsOutput> = {
  id: 'opening/pickMaterials',
  input: PickMaterialsInput,
  output: PickMaterialsOutput,
  reads: ['exam', 'course', 'track-affinity'],
  params: [],
  async run(raw, ctx) {
    const parsed = parseInput(PickMaterialsInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    const affinities = await trainingQuery(ctx.assets, TrackAffinitySlot, {
      field: 'track',
      op: 'eq',
      value: input.track,
    });
    if (affinities.length > 1)
      needs.push(inputNeed('trackAffinity', 'Multiple affinity records exist for the track'));
    const borrowed = affinities[0]?.data.borrowFrom ?? [];
    const exams = [];
    const keys = [...new Set(input.certKeys)];
    const langs = [...new Set(input.langs)];
    for (let offset = 0; offset < keys.length; offset += 200)
      for (let langOffset = 0; langOffset < langs.length; langOffset += 200)
        exams.push(
          ...(await trainingQuery(ctx.assets, ExamSlot, {
            all: [
              { field: 'certKey', op: 'in', value: keys.slice(offset, offset + 200) },
              { field: 'lang', op: 'in', value: langs.slice(langOffset, langOffset + 200) },
            ],
          })),
        );
    const ranked = exams.map((r) => ({
      ref: assetRef(r),
      rank: materialRank(r.coverage, input.track, borrowed),
      borrowedFrom:
        materialRank(r.coverage, input.track, borrowed) === 2
          ? (borrowed.find((t) => r.coverage.tracks.includes(t)) ?? null)
          : null,
      certKey: r.data.certKey,
      lang: r.data.lang,
    }));
    const best = new Map<string, number>();
    for (const paper of ranked) {
      const key = JSON.stringify([paper.certKey, paper.lang]);
      best.set(key, Math.min(best.get(key) ?? paper.rank, paper.rank));
    }
    const papers = ranked.filter((p) => p.rank === best.get(JSON.stringify([p.certKey, p.lang])));
    for (const key of keys)
      for (const lang of langs)
        if (!papers.some((p) => p.certKey === key && p.lang === lang))
          needs.push({
            kind: 'asset',
            slot: 'exam',
            filter: {
              all: [
                { field: 'certKey', op: 'eq', value: key },
                { field: 'lang', op: 'eq', value: lang },
              ],
            },
            reason: 'No examination material for the certification and language',
            blocking: false,
          });
    const courses = (
      await trainingQuery(ctx.assets, CourseSlot, {
        any: [
          { field: 'coverage.tier', op: 'eq', value: 'general' },
          { field: 'coverage.tracks', op: 'hasAny', value: [input.track, ...borrowed] },
        ],
      })
    ).map((r) => ({
      ref: assetRef(r),
      rank: materialRank(r.coverage, input.track, borrowed),
      borrowedFrom:
        materialRank(r.coverage, input.track, borrowed) === 2
          ? (borrowed.find((t) => r.coverage.tracks.includes(t)) ?? null)
          : null,
    }));
    const sort = (a: z.infer<typeof Material>, b: z.infer<typeof Material>) =>
      a.rank - b.rank ||
      (a.borrowedFrom && b.borrowedFrom
        ? borrowed.indexOf(a.borrowedFrom) - borrowed.indexOf(b.borrowedFrom)
        : 0) ||
      (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0);
    papers.sort(sort);
    courses.sort(sort);
    return trainingResult(
      {
        papers,
        courses,
        sources: [
          ...affinities.map((a) => assetRef(a)),
          ...papers.map((p) => p.ref),
          ...courses.map((p) => p.ref),
        ],
      },
      needs,
    );
  },
};
