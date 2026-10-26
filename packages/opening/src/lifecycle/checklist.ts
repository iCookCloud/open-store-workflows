import {
  AssetRef,
  IsoDate,
  Jurisdiction,
  TrackKey,
  type Verification,
  addDays,
  assetRef,
  todayIn,
  z,
} from '@osw/core';
import {
  defineStep,
  inputNeed,
  jurisdictionFit,
  result,
  selectTemplate,
  validArtifact,
  verification,
} from '../helpers.js';
import { OpeningChecklistContent } from '../templates/opening-checklist.js';
import { BuildPlan, Checklist, DeliveryPlan, Timezone } from './models.js';

const Update = z.object({
  key: z.string(),
  status: Checklist.shape.items.element.shape.status,
  note: z.string().optional(),
});
export const ExpandChecklistInput = z.object({
  track: TrackKey,
  jurisdiction: Jurisdiction,
  timezone: Timezone,
  openingDate: IsoDate,
  templateRef: AssetRef.optional(),
  previous: Checklist.optional(),
  updates: z.array(Update).default([]),
  buildPlan: BuildPlan.optional(),
  deliveryPlan: DeliveryPlan.optional(),
});
export const ExpandedChecklist = z.object({
  checklist: Checklist,
  templateItems: OpeningChecklistContent.shape.items,
  checkpoints: z.array(z.string()),
  complaintAreas: z.array(z.string()),
  overdue: z.array(z.string()),
  sources: z.array(AssetRef),
});
export const expandChecklist = defineStep({
  id: 'opening/expandChecklist',
  input: ExpandChecklistInput,
  output: ExpandedChecklist,
  reads: ['template'],
  params: [],
  async run(input, ctx) {
    const selected = await selectTemplate(
      ctx,
      'opening-checklist',
      input.track,
      input.jurisdiction,
      OpeningChecklistContent,
      input.templateRef ?? input.previous?.template,
    );
    const { needs, record, content } = selected;
    for (const upstream of [input.buildPlan, input.deliveryPlan])
      if (upstream) needs.push(...(await validArtifact(upstream, `${upstream.kind}.hash`)));
    if (!record || !content || needs.some((n) => n.blocking))
      return { output: null, needs, verifications: [] };
    const old = new Map(input.previous?.items.map((item) => [item.key, item]));
    const updates = new Map(input.updates.map((item) => [item.key, item]));
    if (updates.size !== input.updates.length)
      needs.push(inputNeed('updates', 'Duplicate checklist update'));
    for (const update of input.updates)
      if (!content.items.some((item) => item.key === update.key))
        needs.push(inputNeed('updates', `Unknown checklist item ${update.key}`));
    const checks: Verification[] = [];
    const ref = assetRef(record);
    const items = content.items.map((item, index) => {
      const fit = jurisdictionFit(input.jurisdiction, item.jurisdiction);
      const previous = old.get(item.key);
      let status: z.infer<typeof Checklist>['items'][number]['status'] =
        fit === 'no' ? 'skipped' : 'todo';
      let note =
        fit === 'no'
          ? 'Jurisdiction does not apply'
          : fit === 'unsure'
            ? 'Confirm the more specific jurisdiction manually'
            : '';
      let dueDate = addDays(input.openingDate, item.dayOffset);
      if (previous && fit !== 'no') {
        status = previous.status;
        note = previous.note;
        if (previous.status === 'done' || previous.status === 'skipped') dueDate = previous.dueDate;
      }
      if (fit !== 'no' && item.upstream === 'acceptance') {
        if (!input.buildPlan)
          needs.push(
            inputNeed(
              `checklist.${item.key}`,
              'Confirm build acceptance manually; BuildPlan is absent',
              false,
            ),
          );
        else if (
          input.buildPlan.body.acceptance.status === 'accepted' &&
          input.buildPlan.body.acceptance.acceptedAt &&
          input.buildPlan.body.acceptance.punch.every((p) => p.closedAt)
        ) {
          status = 'done';
          note = 'BuildPlan acceptance and punch list confirmed';
        } else {
          status = 'todo';
          note = 'Build acceptance is incomplete';
        }
      }
      if (fit !== 'no' && (item.upstream === 'openingStock' || item.upstream === 'fitoutGoods')) {
        const delivery = input.deliveryPlan?.body;
        const milestone =
          item.upstream === 'openingStock'
            ? delivery?.openingStock.lastAt
            : delivery?.fitoutGoodsLastAt;
        if (!delivery)
          needs.push(
            inputNeed(
              `checklist.${item.key}`,
              'Confirm physical receipt manually; DeliveryPlan is absent',
              false,
            ),
          );
        else if (
          milestone?.basis === 'received' &&
          milestone.date &&
          milestone.date <= todayIn(input.timezone, ctx.now)
        ) {
          status = 'done';
          note = 'Physical receipt confirmed';
        } else {
          status = 'todo';
          note = 'Receipt is not confirmed; ETA alone is insufficient';
        }
      }
      if (status === 'skipped' && item.gate && fit !== 'no') {
        status = 'todo';
        note = 'Applicable gate requires completion or conditional release';
      }
      const update = updates.get(item.key);
      if (update) {
        if (update.status === 'skipped' && item.gate && fit !== 'no')
          needs.push(
            inputNeed(
              `updates.${item.key}.note`,
              'An applicable gate cannot be skipped; use conditional release for waivable blockers',
            ),
          );
        if (
          item.upstream &&
          (item.upstream === 'acceptance' ? input.buildPlan : input.deliveryPlan) &&
          status !== 'done' &&
          update.status === 'done'
        )
          needs.push(
            inputNeed(
              `updates.${item.key}`,
              'Manual completion cannot override incomplete upstream evidence',
            ),
          );
        status = update.status;
        note = update.note ?? note;
      }
      if (fit === 'no' && status !== 'skipped')
        checks.push(
          verification(
            ctx,
            { ...ref, path: `/content/items/${index}` },
            'opening/review',
            'jurisdiction',
            'fails',
            'An inapplicable item was reinstated manually',
            [item.key],
          ),
        );
      return {
        key: item.key,
        title: item.title,
        phase: item.phase,
        dayOffset: item.dayOffset,
        dueDate,
        gate: item.gate,
        waivable: item.waivable,
        status,
        note,
      };
    });
    const today = todayIn(input.timezone, ctx.now);
    return result(
      {
        checklist: {
          template: ref,
          firstDay: Math.min(...content.items.map((item) => item.dayOffset)),
          lastDay: Math.max(...content.items.map((item) => item.dayOffset)),
          items,
        },
        templateItems: content.items,
        checkpoints: [
          ...new Set(
            content.items.flatMap((item) => (item.reviewCheckpoint ? [item.reviewCheckpoint] : [])),
          ),
        ],
        complaintAreas: content.complaintAreas,
        overdue: items
          .filter((item) => !['done', 'skipped'].includes(item.status) && item.dueDate < today)
          .map((item) => item.key),
        sources: [ref],
      },
      needs,
      checks,
    );
  },
});
export const reschedule = defineStep({
  id: 'opening/reschedule',
  input: z.object({ checklist: Checklist, openingDate: IsoDate }),
  output: Checklist,
  reads: [],
  params: [],
  async run(input) {
    return result({
      ...input.checklist,
      items: input.checklist.items.map((item) =>
        ['todo', 'doing'].includes(item.status)
          ? { ...item, dueDate: addDays(input.openingDate, item.dayOffset) }
          : item,
      ),
    });
  },
});
