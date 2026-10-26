import {
  AssetRef,
  MenuSlot,
  Money,
  type Need,
  type Verification,
  convertMoney,
  divMoney,
  sumMoney,
  versionHash,
  z,
} from '@osw/core';
import {
  assetRef,
  defineStep,
  inputNeed,
  latestApproval,
  result,
  validArtifact,
  verification,
  withOpeningParams,
} from '../helpers.js';
import { CourseSlot } from '../slots/course.js';
import { OpeningChecklistContent } from '../templates/opening-checklist.js';
import { OpeningRecord, Review, StoreSpec } from './models.js';
const CostActionInput = Review.shape.costActions.element.extend({
  baseline: z.string(),
  action: z.string(),
  expected: z.string(),
});
const LessonInput = Review.shape.lessons.element.extend({
  lesson: z.string(),
  condition: z.string(),
});
export const ReviewObservation = z.object({
  checkpoint: z.string(),
  period: z.enum(['checkpoint', 'openingMonth']).default('checkpoint'),
  orders: z.number().int().nonnegative(),
  revenue: Money,
  labor: Money.nullable().default(null),
  foodCost: Money.nullable().default(null),
  waste: Money.nullable().default(null),
  costActions: z.array(CostActionInput).default([]),
  lessons: z.array(LessonInput).default([]),
});
export const ReviewInput = z.object({
  record: OpeningRecord,
  storeSpec: StoreSpec,
  templateItems: OpeningChecklistContent.shape.items,
  complaintAreas: z.array(z.string()),
  observations: z.array(ReviewObservation),
});
export const review = defineStep({
  id: 'opening/review',
  input: ReviewInput,
  output: z.object({ reviews: z.array(Review), sources: z.array(AssetRef) }),
  reads: ['course', 'menu', 'params'],
  params: [],
  approval: { question: 'Sign this checkpoint review?', decision: z.literal('signed') },
  async run(input, baseCtx) {
    const scope = { track: input.record.body.track, jurisdiction: input.record.body.jurisdiction };
    const targetCurrency = input.storeSpec.body.economics.spend.currency;
    const fxKeys = input.observations.flatMap((row) =>
      [row.revenue, row.labor, row.foodCost, row.waste].flatMap((value) =>
        value && value.currency !== targetCurrency
          ? [`fx.${value.currency}.${targetCurrency}`]
          : [],
      ),
    );
    const ctx = await withOpeningParams(baseCtx, fxKeys, scope);
    const needs: Need[] = [
      ...(await validArtifact(input.record, 'record.hash')),
      ...(await validArtifact(input.storeSpec, 'storeSpec.hash')),
    ];
    if (input.record.storeId !== input.storeSpec.storeId)
      needs.push(inputNeed('storeSpec.storeId', 'Review artifacts must belong to the same store'));
    const checkpoints = new Set(
      input.templateItems.flatMap((item) => (item.reviewCheckpoint ? [item.reviewCheckpoint] : [])),
    );
    const reviews = new Map(input.record.body.reviews.map((item) => [item.checkpoint, item]));
    const checks: Verification[] = [];
    for (const observation of input.observations) {
      if (!checkpoints.has(observation.checkpoint)) {
        needs.push(inputNeed('checkpoint', `Unknown review checkpoint ${observation.checkpoint}`));
        continue;
      }
      const currency = input.storeSpec.body.economics.spend.currency;
      const convert = (value: z.infer<typeof Money> | null) => {
        if (!value) return null;
        const converted = convertMoney(value, currency, ctx.params, scope);
        needs.push(...converted.needs);
        return converted.value;
      };
      const revenue = convert(observation.revenue);
      const labor = convert(observation.labor);
      const foodCost = convert(observation.foodCost);
      const waste = convert(observation.waste);
      if (!revenue) continue;
      const costActions = observation.costActions.filter(
        (row) =>
          row.baseline.trim() || row.action.trim() || row.expected.trim() || row.actual.trim(),
      );
      const lessons = observation.lessons.filter(
        (row) => row.lesson.trim() || row.condition.trim(),
      );
      for (const action of costActions) {
        if (!action.baseline.trim() || !action.action.trim() || !action.expected.trim())
          needs.push(
            inputNeed('costActions', 'Cost actions require baseline, action and expected outcome'),
          );
        if (!action.actual.trim()) action.decision = 'pending';
      }
      for (const lesson of lessons)
        if (!lesson.lesson.trim() || !lesson.condition.trim())
          needs.push(inputNeed('lessons', 'Lessons require their reuse condition'));
      const content = {
        checkpoint: observation.checkpoint,
        kpis: {
          orders: observation.orders,
          revenue,
          labor,
          foodCost,
          waste,
          averageTicket: divMoney(revenue, observation.orders),
          primeCostRate:
            labor && foodCost && revenue.amount > 0
              ? sumMoney([labor, foodCost]).amount / revenue.amount
              : null,
        },
        costActions,
        lessons,
      };
      const hash = await versionHash(content);
      const subject = `checkpoint:${observation.checkpoint}`;
      const approval = latestApproval(ctx, 'opening/review', hash, subject);
      const signedAt = approval?.decision === 'signed' ? approval.at : null;
      if (!signedAt)
        needs.push({
          kind: 'approval',
          step: 'opening/review',
          subject,
          subjectHash: hash,
          question: 'Sign this checkpoint review',
          blocking: false,
        });
      reviews.set(observation.checkpoint, { ...content, signedAt });
      if (observation.period === 'openingMonth') {
        for (const source of input.storeSpec.sources.filter(
          (ref) => ref.slot === 'calc-template',
        )) {
          const values = [
            {
              field: 'spend',
              expected: input.storeSpec.body.economics.spend,
              actual: content.kpis.averageTicket,
            },
            {
              field: 'breakeven',
              expected:
                input.storeSpec.body.economics.breakeven.status === 'ok'
                  ? input.storeSpec.body.economics.breakeven.revenue
                  : null,
              actual: revenue,
            },
          ];
          for (const row of values)
            if (row.actual)
              checks.push({
                ...verification(
                  ctx,
                  source,
                  'opening/review',
                  row.field,
                  'pending',
                  'Observed opening-month result; no tolerance or causal conclusion is assumed',
                ),
                measured: {
                  field: row.field,
                  expected: row.expected?.amount ?? null,
                  actual: row.actual.amount,
                  unit: currency,
                  ...(row.expected ? { delta: row.actual.amount - row.expected.amount } : {}),
                },
              });
        }
      }
    }
    // 仅有复盘事实时评价资产；没有首月观察不能凭空声称课程或清单有效。
    if (input.observations.some((observation) => observation.period === 'openingMonth')) {
      const issues = input.record.body.issues.filter(
        (issue) =>
          ['P0', 'P1'].includes(issue.severity) || input.complaintAreas.includes(issue.area),
      );
      const refMatches = (left: z.infer<typeof AssetRef>, right: z.infer<typeof AssetRef>) =>
        left.slot === right.slot &&
        left.id === right.id &&
        left.versionHash === right.versionHash &&
        (!left.path || !right.path || left.path === right.path);
      const menu = await ctx.assets.get(MenuSlot, input.record.body.menuRef.id);
      if (menu && menu.versionHash !== input.record.body.menuRef.versionHash)
        needs.push(inputNeed('menuRef', 'Menu changed since the opening record'));
      const courseRefs = [
        ...new Map(
          input.record.sources.filter((ref) => ref.slot === 'course').map((ref) => [ref.id, ref]),
        ).values(),
      ];
      for (const ref of courseRefs) {
        const course = await ctx.assets.get(CourseSlot, ref.id);
        if (!course || course.versionHash !== ref.versionHash) {
          needs.push(
            inputNeed(
              `course.${ref.id}`,
              'Course version used by the opening record is unavailable',
            ),
          );
          continue;
        }
        for (const [index, unit] of course.data.units.entries()) {
          const unitRef = assetRef(course, undefined, `/units/${index}`);
          const dishRefs =
            menu?.data.items?.flatMap((item, itemIndex) =>
              unit.covers.includes(item.id)
                ? [{ ...input.record.body.menuRef, path: `/items/${itemIndex}` }]
                : [],
            ) ?? [];
          const failures = issues.filter((issue) =>
            issue.refs.some((target) =>
              [unitRef, ...dishRefs].some((ref) => refMatches(target, ref)),
            ),
          );
          const cells = input.record.body.certMatrix.cells.filter(
            (cell) => cell.sop && refMatches(cell.sop, unitRef),
          );
          const verdict = failures.length
            ? 'fails'
            : cells.length && cells.every((cell) => cell.state === 'passed')
              ? 'holds'
              : 'pending';
          checks.push(
            verification(
              ctx,
              unitRef,
              'opening/review',
              'sopQuality',
              verdict,
              failures.length
                ? 'Opening issues point to this SOP or its mapped dish'
                : 'Opening-month SOP observations',
              failures.map((issue) => issue.id),
            ),
          );
        }
      }
      for (const [index, item] of input.templateItems.entries()) {
        const itemRef = {
          ...input.record.body.checklist.template,
          path: `/content/items/${index}`,
        };
        const failures = issues.filter(
          (issue) =>
            ['P0', 'P1'].includes(issue.severity) &&
            issue.refs.some((ref) => refMatches(ref, itemRef)),
        );
        if (
          item.gate &&
          input.record.body.checklist.items.some(
            (row) => row.key === item.key && row.status === 'done',
          )
        )
          checks.push(
            verification(
              ctx,
              itemRef,
              'opening/review',
              'gateEffective',
              failures.length ? 'fails' : 'holds',
              'Opening-month issues compared with completed gate',
              failures.map((issue) => issue.id),
            ),
          );
        if (
          input.record.body.release.signed?.decision === 'go_with_conditions' &&
          input.record.body.release.signed.snapshot.some(
            (blocker) => blocker.kind === 'checklist' && blocker.ref === item.key,
          )
        ) {
          const p0 = failures.filter((issue) => issue.severity === 'P0');
          if (p0.length)
            checks.push(
              verification(
                ctx,
                itemRef,
                'opening/signRelease',
                'waivable',
                'fails',
                'A conditionally waived gate led to P0 issues',
                [item.key, ...p0.map((issue) => issue.id)],
              ),
            );
        }
      }
    }
    return result(
      {
        reviews: [...reviews.values()],
        sources: fxKeys.flatMap((key) => ctx.params.refs?.(key, scope) ?? []),
      },
      needs,
      checks,
    );
  },
});
