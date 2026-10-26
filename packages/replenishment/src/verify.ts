import {
  AssetRef,
  IsoDateTime,
  MenuSlot,
  type Need,
  OfferSlot,
  RecipeSlot,
  type StepDef,
  Verification,
  z,
} from '@osw/core';
import { numericParam, queryAll, result } from './helpers.js';
import { ReorderLine, lineKey, orderPlacedAt, reorderSlot } from './models-reorder.js';
import { replySlot, segmentRulesetSlot, sendLogSlot } from './slots.js';

const Input = z.object({
  storeId: z.string().min(1),
  openedAt: IsoDateTime,
  initialArrivedAt: IsoDateTime.optional(),
  menuRef: AssetRef.optional(),
  seedLines: z.array(ReorderLine).optional(),
  rulesetRef: AssetRef.optional(),
  campaignIds: z.array(z.string()).optional(),
});
const Output = z.object({ verifications: z.array(Verification) });
export const verifyUpstream: StepDef<typeof Input, typeof Output> = {
  id: 'replenishment/verifyUpstream',
  input: Input,
  output: Output,
  reads: ['menu', 'recipe', 'reorder', 'offer', 'send-log', 'reply', 'segment-ruleset'],
  params: [
    {
      key: 'verify.menu.windowDays',
      required: false,
      description: 'Observation window after opening',
    },
    {
      key: 'verify.menu.minShare',
      required: false,
      description: 'Minimum recipe ingredient share reordered',
    },
    {
      key: 'verify.segment.minSample',
      required: false,
      description: 'Minimum sent sample for variant verification',
    },
    {
      key: 'verify.segment.minReplyRate',
      required: false,
      description: 'Minimum useful reply rate per variant',
    },
    { key: 'nl.breaker.unsub', required: false, description: 'Maximum unsubscribe share' },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const base = { purpose: 'replenishment/verifyUpstream', at: ctx.now, by: ctx.actor };
    const orders = (
      await queryAll(ctx.assets, reorderSlot, { field: 'storeId', op: 'eq', value: input.storeId })
    )
      .filter(
        (record) =>
          record.data.state === 'delivered' &&
          Date.parse(orderPlacedAt(record.data)) > Date.parse(input.openedAt) &&
          Date.parse(orderPlacedAt(record.data)) <= Date.parse(ctx.now),
      )
      .sort(
        (a, b) =>
          Date.parse(orderPlacedAt(a.data)) - Date.parse(orderPlacedAt(b.data)) ||
          (a.id < b.id ? -1 : 1),
      );
    if (input.menuRef) {
      const menu = await ctx.assets.get(MenuSlot, input.menuRef.id);
      const windowDays = numericParam(ctx, 'verify.menu.windowDays', needs, { min: 0 });
      const minShare = numericParam(ctx, 'verify.menu.minShare', needs, { min: 0, max: 1 });
      const expected = new Set<string>();
      let incomplete =
        !menu ||
        Boolean(menu.redacted?.length) ||
        menu.versionHash !== input.menuRef.versionHash ||
        !menu.data.items?.length;
      if (menu?.data.items)
        for (const item of menu.data.items) {
          if (!item.recipeId) {
            incomplete = true;
            continue;
          }
          const recipe = await ctx.assets.get(RecipeSlot, item.recipeId);
          if (!recipe || recipe.redacted?.length) {
            incomplete = true;
            continue;
          }
          for (const ingredient of recipe.data.ingredients) {
            if (ingredient.productId) expected.add(ingredient.productId);
            // 术语与产品不等价；投影尚未解析术语时不能把未知分母判成通过。
            else if (ingredient.termKey) incomplete = true;
          }
        }
      const reordered = new Set(orders.flatMap((record) => record.data.lines.map(lineKey)));
      const missing = [...expected].filter((key) => !reordered.has(key));
      const share = expected.size ? 1 - missing.length / expected.size : 0;
      const elapsed = (Date.parse(ctx.now) - Date.parse(input.openedAt)) / 86400000;
      const pending =
        incomplete ||
        !expected.size ||
        windowDays === null ||
        minShare === null ||
        elapsed < windowDays;
      verifications.push({
        ...base,
        asset: input.menuRef,
        dimension: 'menuIngredients',
        verdict: pending ? 'pending' : share >= (minShare as number) ? 'holds' : 'fails',
        reason: pending
          ? 'Menu ingredients or observation window are incomplete'
          : share >= (minShare as number)
            ? 'Menu ingredients are supported by replenishment orders'
            : 'Some menu ingredients were never reordered',
        measured: { field: 'reorderedIngredientShare', expected: minShare, actual: share },
        evidence: missing.slice(0, 20),
      });
    }
    for (const seed of input.seedLines ?? []) {
      const initialRef = seed.initialOfferRef ?? seed.offerRef;
      if (!initialRef) continue;
      const offer = await ctx.assets.get(OfferSlot, initialRef.id);
      const match = orders
        .flatMap((record) => record.data.lines.map((line) => ({ record, line })))
        .find(({ line }) => lineKey(line) === lineKey(seed) || line.id === seed.id);
      const validVersion =
        offer &&
        !offer.redacted?.length &&
        (offer.versionHash === initialRef.versionHash ||
          offer.fieldsetHashes?.[initialRef.fieldset ?? ''] === initialRef.versionHash);
      const same =
        match &&
        offer &&
        match.record.data.supplierId === offer.data.partyId &&
        match.line.productRef?.id === seed.productRef?.id;
      verifications.push({
        ...base,
        asset: initialRef,
        dimension: 'bomSupplier',
        verdict: !validVersion || !match ? 'pending' : same ? 'holds' : 'fails',
        reason: !validVersion
          ? 'Initial offer version is unavailable'
          : !match
            ? 'No delivered replenishment observed for this ingredient'
            : same
              ? 'Ingredient was reordered from its initial supplier and product'
              : 'Replenishment changed the product or supplier',
        ...(match && seed.coverDays && input.initialArrivedAt
          ? {
              measured: {
                field: 'daysOfCover',
                expected: seed.coverDays,
                actual:
                  (Date.parse(orderPlacedAt(match.record.data)) -
                    Date.parse(input.initialArrivedAt)) /
                  86400000,
                unit: 'day',
              },
            }
          : {}),
        ...(match
          ? {
              evidence: [match.line.productRef?.id ?? match.line.key, match.record.data.supplierId],
            }
          : {}),
      });
    }
    if (input.rulesetRef && input.campaignIds?.length) {
      const ruleset = await ctx.assets.get(segmentRulesetSlot, input.rulesetRef.id);
      const minSample = numericParam(ctx, 'verify.segment.minSample', needs, {
        min: 1,
        integer: true,
      });
      const minReply = numericParam(ctx, 'verify.segment.minReplyRate', needs, { min: 0, max: 1 });
      const maxUnsub = numericParam(ctx, 'nl.breaker.unsub', needs, { min: 0, max: 1 });
      const logs = [];
      for (let index = 0; index < input.campaignIds.length; index += 200)
        logs.push(
          ...(await queryAll(ctx.assets, sendLogSlot, {
            field: 'campaignId',
            op: 'in',
            value: input.campaignIds.slice(index, index + 200),
          })),
        );
      const variants = new Map<string, typeof logs>();
      for (const log of logs) {
        const key = `${log.data.campaignId}|${log.data.variantKey}`;
        const group = variants.get(key) ?? [];
        group.push(log);
        variants.set(key, group);
      }
      for (const [key, group] of variants) {
        const sent = group.filter((record) => record.data.status === 'sent');
        const replies = [];
        for (let index = 0; index < sent.length; index += 200)
          replies.push(
            ...(await queryAll(ctx.assets, replySlot, {
              field: 'sendId',
              op: 'in',
              value: sent.slice(index, index + 200).map((record) => record.id),
            })),
          );
        const useful = new Set(
          replies
            .filter((record) => ['interested', 'order', 'question'].includes(record.data.kind))
            .map((record) => record.data.contactId),
        );
        const attributed = await queryAll(ctx.assets, reorderSlot, {
          field: 'attribution.campaignId',
          op: 'eq',
          value: group[0].data.campaignId,
        });
        const orderCount = attributed.filter(
          (record) =>
            record.data.state === 'delivered' &&
            record.data.attribution?.variantKey === group[0].data.variantKey,
        ).length;
        const replyRate = sent.length ? useful.size / sent.length : 0;
        const unsubscribe = sent.length
          ? sent.filter((record) => record.data.event === 'unsub').length / sent.length
          : 0;
        const pending =
          !ruleset ||
          ruleset.versionHash !== input.rulesetRef.versionHash ||
          minSample === null ||
          minReply === null ||
          maxUnsub === null ||
          sent.length < minSample;
        verifications.push({
          ...base,
          asset: { ...input.rulesetRef, path: `/segmentReply/${encodeURIComponent(key)}` },
          dimension: 'segmentReply',
          verdict: pending
            ? 'pending'
            : replyRate < (minReply as number) || unsubscribe > (maxUnsub as number)
              ? 'fails'
              : 'holds',
          reason: pending
            ? 'Variant sample or ruleset version is insufficient'
            : replyRate < (minReply as number)
              ? 'Variant useful reply rate is below threshold'
              : unsubscribe > (maxUnsub as number)
                ? 'Variant unsubscribe share exceeds threshold'
                : 'Variant has sufficient useful reply evidence',
          measured: { field: 'replyRate', expected: minReply, actual: replyRate },
          evidence: [
            `variant:${key}`,
            `sent:${sent.length}`,
            `replies:${useful.size}`,
            `orders:${orderCount}`,
            `unsubscribe:${unsubscribe}`,
          ],
        });
      }
    }
    return result({ verifications }, needs, verifications);
  },
};
