import {
  type AssetRecordOf,
  AssetRef,
  Currency,
  IsoDateTime,
  type Money,
  type Need,
  type Offer,
  OfferSlot,
  type ParamReader,
  ParamsSlot,
  PartySlot,
  ProductSlot,
  type StepCtx,
  type StepDef,
  StoreSlot,
  type Verification,
  assetRef,
  convertMeasure,
  convertMoney,
  createParamReader,
  roundMoney,
  unitPriceAt,
  versionHash,
  z,
} from '@osw/core';
import { approvalNeed, currentApproval, numericParam, queryAll, result } from './helpers.js';
import {
  FrequentLine,
  ReceiptLine,
  ReorderLine,
  ReorderOrder,
  lineKey,
  orderPlacedAt,
  reorderSlot,
} from './models-reorder.js';
import { sendLogSlot, storeContactSlot } from './slots.js';

const DAY = 86400000;
const timestamp = (value: string) => (value.length === 10 ? `${value}T00:00:00Z` : value);
const inputNeed = (path: string, reason: string): Need => ({
  kind: 'input',
  path,
  reason,
  blocking: true,
});
function convertedQuantity(
  qty: number,
  from: ReorderLine['unit'],
  to: ReorderLine['unit'],
): number | null {
  if (from === to) return qty;
  const converted = convertMeasure({ value: qty, unit: from }, to).value;
  return converted && typeof converted.value === 'number' ? converted.value : null;
}

const FrequentInput = z.object({
  storeId: z.string().min(1),
  openedAt: IsoDateTime.optional(),
  seedLines: z.array(ReorderLine).optional(),
});
export const FrequentOutput = z.object({
  lines: z.array(FrequentLine),
  skipped: z.array(z.string()),
});
export const frequentList: StepDef<typeof FrequentInput, typeof FrequentOutput> = {
  id: 'replenishment/frequentList',
  input: FrequentInput,
  output: FrequentOutput,
  reads: ['reorder', 'product', 'store'],
  params: [
    {
      key: 'reorder.minIntervals',
      required: true,
      description: 'Minimum observed intervals to infer replenishment cadence',
    },
    { key: 'reorder.graceDays', required: true, description: 'Days after due date before overdue' },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const store = await ctx.assets.get(StoreSlot, input.storeId);
    const openedAt =
      input.openedAt ?? (store?.data.openedAt ? timestamp(store.data.openedAt) : undefined);
    if (!store)
      needs.push({
        kind: 'asset',
        slot: 'store',
        filter: { field: 'id', op: 'eq', value: input.storeId },
        reason: 'Store is missing',
        blocking: true,
      });
    if (!openedAt)
      needs.push(
        inputNeed(
          'openedAt',
          'Opening time is required to separate opening stock from replenishment',
        ),
      );
    if (store?.redacted?.some((field) => /(?:status|openedAt|jurisdiction|track)/.test(field)))
      needs.push({
        kind: 'asset',
        slot: 'store',
        filter: { field: 'id', op: 'eq', value: input.storeId },
        reason: 'Required store fields are redacted',
        blocking: true,
      });
    const scope = store ? { jurisdiction: store.data.jurisdiction, track: store.data.track } : {};
    const minIntervals = numericParam(
      ctx,
      'reorder.minIntervals',
      needs,
      { min: 1, integer: true },
      scope,
    );
    const graceDays = numericParam(ctx, 'reorder.graceDays', needs, { min: 0 }, scope);
    if (needs.some((need) => need.blocking)) return result({ lines: [], skipped: [] }, needs);
    const orders = (
      await queryAll(ctx.assets, reorderSlot, { field: 'storeId', op: 'eq', value: input.storeId })
    )
      .filter(
        (record) =>
          ['confirmed', 'delivered'].includes(record.data.state) &&
          Date.parse(orderPlacedAt(record.data)) > Date.parse(openedAt as string) &&
          Date.parse(orderPlacedAt(record.data)) <= Date.parse(ctx.now),
      )
      .sort(
        (a, b) =>
          Date.parse(orderPlacedAt(a.data)) - Date.parse(orderPlacedAt(b.data)) ||
          (a.id < b.id ? -1 : 1),
      );
    const grouped = new Map<
      string,
      { line: ReorderLine; supplierId?: string; at: string[]; lastPaid?: Money }
    >();
    const skipped: string[] = [];
    async function allowed(line: ReorderLine) {
      const product = line.productRef
        ? await ctx.assets.get(ProductSlot, line.productRef.id)
        : null;
      if (line.productRef && !product) {
        needs.push({
          kind: 'asset',
          slot: 'product',
          filter: { field: 'id', op: 'eq', value: line.productRef.id },
          reason: 'Referenced product is missing',
          blocking: true,
        });
        return false;
      }
      if (product?.coverage.frequency === 'opening') {
        skipped.push(line.name);
        return false;
      }
      return true;
    }
    for (const line of input.seedLines ?? [])
      if (await allowed(line))
        grouped.set(lineKey(line), {
          line: { ...line, key: lineKey(line), weakKey: !line.productRef },
          at: [],
          ...(line.unitPrice ? { lastPaid: line.unitPrice } : {}),
        });
    for (const record of orders)
      for (const line of record.data.lines) {
        if (!(await allowed(line))) continue;
        const key = lineKey(line);
        const prior = grouped.get(key);
        const at = orderPlacedAt(record.data);
        const priceFactor = prior ? convertedQuantity(1, line.unit, prior.line.unit) : null;
        const lastPaid =
          record.data.state === 'delivered' && line.unitPrice
            ? line.unitPrice
            : prior?.lastPaid && priceFactor !== null
              ? roundMoney({
                  amount: prior.lastPaid.amount * priceFactor,
                  currency: prior.lastPaid.currency,
                })
              : undefined;
        grouped.set(key, {
          line: {
            ...line,
            key,
            weakKey: !line.productRef,
            ...(prior?.line.initialOfferRef && !line.initialOfferRef
              ? { initialOfferRef: prior.line.initialOfferRef }
              : {}),
          },
          supplierId: record.data.supplierId,
          at: [...(prior?.at ?? []), at],
          ...(lastPaid ? { lastPaid } : {}),
        });
      }
    const lines: FrequentLine[] = [];
    for (const [key, group] of [...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const times = [...new Set(group.at.map(Date.parse))].sort((a, b) => a - b);
      const intervals = times
        .slice(1)
        .map((at, index) => at - times[index])
        .sort((a, b) => a - b);
      const middle = Math.floor(intervals.length / 2);
      const median =
        intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
      const lastAt = times.length ? new Date(times.at(-1) as number).toISOString() : null;
      const dueAt =
        intervals.length >= (minIntervals as number)
          ? new Date((times.at(-1) as number) + median).toISOString()
          : null;
      lines.push({
        ...group.line,
        key,
        unitPrice: group.lastPaid,
        priceSource: group.lastPaid ? 'last-paid' : 'unpriced',
        ...(group.supplierId ? { supplierId: group.supplierId } : {}),
        ...(group.lastPaid ? { lastPaid: group.lastPaid } : {}),
        lastAt,
        dueAt,
        overdue:
          dueAt !== null && Date.parse(ctx.now) > Date.parse(dueAt) + (graceDays as number) * DAY,
        orderCount: group.at.length,
      });
    }
    return result({ lines, skipped: [...new Set(skipped)].sort() }, needs);
  },
};

const SelectedLine = z.object({ line: ReorderLine, supplierId: z.string().min(1) });
const DraftInput = z.object({
  storeId: z.string().min(1),
  currency: Currency,
  selected: z.array(SelectedLine).min(1),
  attribution: z
    .object({ campaignId: z.string().min(1), variantKey: z.string().min(1) })
    .optional(),
});
export const OrderEntry = z.object({ orderId: z.string(), order: ReorderOrder });
export const DraftOutput = z.object({ orders: z.array(OrderEntry), skipped: z.array(z.string()) });

async function fxReader(
  ctx: StepCtx,
  currency: string,
  target: string,
  scope: { jurisdiction?: string; track?: string },
): Promise<ParamReader> {
  const key = `fx.${currency}.${target}`;
  if (
    currency === target ||
    ctx.params.get(key, scope) ||
    (ctx.params.need?.(key, scope)?.kind === 'param' &&
      (ctx.params.need?.(key, scope) as { reason?: string }).reason === 'ambiguous')
  )
    return ctx.params;
  const records = await queryAll(ctx.assets, ParamsSlot, { field: 'key', op: 'eq', value: key });
  const extra = createParamReader(records, ctx.now, scope);
  return {
    get: (name, at) => ctx.params.get(name, at) ?? extra.get(name, at),
    need: (name, at) => extra.need?.(name, at) ?? ctx.params.need?.(name, at),
    refs: (name, at) =>
      ctx.params.get(name, at)
        ? (ctx.params.refs?.(name, at) ?? [])
        : (extra.refs?.(name, at) ?? []),
  };
}

async function linePrice(
  offer: AssetRecordOf<Offer>,
  line: ReorderLine,
  ctx: StepCtx,
  target: string,
  scope: { jurisdiction?: string; track?: string },
  needs: Need[],
): Promise<Money | null> {
  if (offer.redacted?.length) {
    needs.push({
      kind: 'asset',
      slot: 'offer',
      filter: { field: 'id', op: 'eq', value: offer.id },
      reason: 'Required pricing fields are redacted',
      blocking: true,
    });
    return null;
  }
  const qty = convertedQuantity(line.qty, line.unit, offer.data.unit);
  if (qty === null) {
    needs.push(inputNeed(`lines.${line.key}.unit`, 'Order and offer units cannot be converted'));
    return null;
  }
  const price = unitPriceAt(offer.data, qty);
  if (!price) {
    needs.push({
      kind: 'action',
      action: 'meetRepeatMinimum',
      ref: offer.id,
      reason: 'Quantity does not meet the repeat offer MOQ or first tier',
      blocking: true,
    });
    return null;
  }
  const perLineUnit = convertedQuantity(1, line.unit, offer.data.unit);
  const converted = convertMoney(
    { amount: price.amount * (perLineUnit as number), currency: price.currency },
    target,
    await fxReader(ctx, price.currency, target, scope),
    scope,
  );
  needs.push(...converted.needs);
  return converted.value;
}

export const draftReorder: StepDef<typeof DraftInput, typeof DraftOutput> = {
  id: 'replenishment/draftReorder',
  input: DraftInput,
  output: DraftOutput,
  reads: ['offer', 'params', 'product', 'party', 'store', 'store-contact', 'send-log'],
  params: [
    {
      key: 'nl.attributionDays',
      required: false,
      description: 'Maximum lookback for inferred last-send order attribution',
    },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const store = await ctx.assets.get(StoreSlot, input.storeId);
    if (!store || store.data.status !== 'operating')
      return result({ orders: [], skipped: [] }, [
        {
          kind: 'action',
          action: 'admitStore',
          ref: input.storeId,
          reason: 'Only operating stores may reorder',
          blocking: true,
        },
      ]);
    const scope = { jurisdiction: store.data.jurisdiction, track: store.data.track };
    const groups = new Map<string, ReorderLine[]>();
    const skipped: string[] = [];
    for (const selected of input.selected) {
      const line: ReorderLine = {
        ...selected.line,
        key: lineKey(selected.line),
        weakKey: !selected.line.productRef,
      };
      const product = line.productRef
        ? await ctx.assets.get(ProductSlot, line.productRef.id)
        : null;
      if (product?.coverage.frequency === 'opening') {
        skipped.push(line.name);
        continue;
      }
      const supplier = await ctx.assets.get(PartySlot, selected.supplierId);
      if (line.productRef && !product) {
        needs.push({
          kind: 'asset',
          slot: 'product',
          filter: { field: 'id', op: 'eq', value: line.productRef.id },
          reason: 'Selected product is missing',
          blocking: true,
        });
        continue;
      }
      if (
        !supplier ||
        supplier.data.status !== 'active' ||
        !supplier.data.roles?.includes('supplier')
      ) {
        needs.push(inputNeed('selected.supplierId', 'Supplier must be an active supplier party'));
        continue;
      }
      let offers = line.productRef
        ? (
            await queryAll(ctx.assets, OfferSlot, {
              all: [
                { field: 'partyId', op: 'eq', value: selected.supplierId },
                { field: 'productId', op: 'eq', value: line.productRef.id },
                { field: 'use', op: 'eq', value: 'repeat' },
              ],
            })
          )
            .filter((record) => {
              if (record.redacted?.length) {
                needs.push({
                  kind: 'asset',
                  slot: 'offer',
                  filter: { field: 'id', op: 'eq', value: record.id },
                  reason: 'Repeat offer fields are redacted',
                  blocking: true,
                });
                return false;
              }
              return (
                (!record.data.validFrom || record.data.validFrom <= ctx.now.slice(0, 10)) &&
                (!record.data.validUntil || record.data.validUntil >= ctx.now.slice(0, 10))
              );
            })
            .sort((a, b) =>
              a.data.quotedAt > b.data.quotedAt
                ? -1
                : a.data.quotedAt < b.data.quotedAt
                  ? 1
                  : a.id < b.id
                    ? -1
                    : 1,
            )
        : [];
      const selectedOffer = offers.find((offer) => offer.id === line.offerRef?.id);
      if (selectedOffer && line.offerRef) {
        if (
          selectedOffer.versionHash !== line.offerRef.versionHash &&
          selectedOffer.fieldsetHashes?.[line.offerRef.fieldset ?? ''] !== line.offerRef.versionHash
        ) {
          needs.push({
            kind: 'asset',
            slot: 'offer',
            filter: { field: 'id', op: 'eq', value: selectedOffer.id },
            reason: 'Selected repeat offer changed after it was viewed',
            blocking: true,
          });
          continue;
        }
        offers = [selectedOffer];
      }
      if (
        offers.length > 1 &&
        offers[0].data.quotedAt === offers[1].data.quotedAt &&
        offers[0].versionHash !== offers[1].versionHash
      )
        needs.push(
          inputNeed(
            `selected.${line.key}.offer`,
            'Equally current repeat offers are ambiguous; choose one explicitly',
          ),
        );
      if (offers.length) {
        const offer = offers[0];
        const price = await linePrice(offer, line, ctx, input.currency, scope, needs);
        if (!price) continue;
        line.unitPrice = price;
        line.priceSource = 'repeat-offer';
        line.offerRef = assetRef(offer);
      } else if (line.unitPrice && line.priceSource === 'last-paid') {
        const converted = convertMoney(
          line.unitPrice,
          input.currency,
          await fxReader(ctx, line.unitPrice.currency, input.currency, scope),
          scope,
        );
        needs.push(...converted.needs);
        if (!converted.value) continue;
        line.unitPrice = converted.value;
        line.priceSource = 'last-paid';
        line.offerRef = undefined;
      } else {
        needs.push({
          kind: 'action',
          action: 'requestRepeatQuote',
          ref: line.productRef?.id ?? line.key,
          reason: 'No valid repeat offer or last paid price',
          blocking: true,
        });
        continue;
      }
      const group = groups.get(selected.supplierId) ?? [];
      if (group.some((existing) => existing.key === line.key)) {
        needs.push(inputNeed('selected', 'Select each product or weak key only once per supplier'));
        continue;
      }
      group.push(line);
      groups.set(selected.supplierId, group);
    }
    let attribution: ReorderOrder['attribution'] = input.attribution
      ? { ...input.attribution, how: 'link' }
      : undefined;
    if (!attribution && groups.size) {
      const contacts = await queryAll(ctx.assets, storeContactSlot, {
        field: 'storeId',
        op: 'eq',
        value: input.storeId,
      });
      const logs = [];
      for (let start = 0; start < contacts.length; start += 200)
        logs.push(
          ...(await queryAll(ctx.assets, sendLogSlot, {
            field: 'contactId',
            op: 'in',
            value: contacts.slice(start, start + 200).map((record) => record.id),
          })),
        );
      const sent = logs
        .filter(
          (record) =>
            record.data.status === 'sent' && Date.parse(record.data.at) <= Date.parse(ctx.now),
        )
        .sort((a, b) => Date.parse(b.data.at) - Date.parse(a.data.at) || (a.id < b.id ? -1 : 1));
      if (sent.length) {
        const days = numericParam(ctx, 'nl.attributionDays', needs, { min: 0 }, scope);
        if (days !== null && Date.parse(ctx.now) - Date.parse(sent[0].data.at) <= days * DAY)
          attribution = {
            campaignId: sent[0].data.campaignId,
            variantKey: sent[0].data.variantKey,
            how: 'window',
          };
      }
    }
    const orders: z.infer<typeof OrderEntry>[] = [];
    for (const [supplierId, lines] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const subjectHash = await versionHash(lines);
      const orderId = `reorder-${(await versionHash({ storeId: input.storeId, supplierId, lines, at: ctx.now })).slice(0, 24)}`;
      const order: ReorderOrder = {
        storeId: input.storeId,
        supplierId,
        lines,
        skipped,
        state: 'draft',
        history: [{ state: 'draft', at: ctx.now, by: ctx.actor, subjectHash }],
        ...(attribution ? { attribution } : {}),
      };
      if (lines.some((line) => line.priceSource === 'last-paid')) {
        const need = approvalNeed(
          ctx,
          'replenishment/draftReorder',
          `price:${orderId}`,
          subjectHash,
          'approve',
        );
        if (need) needs.push(need);
      }
      orders.push({ orderId, order });
    }
    if (!orders.length && !needs.some((need) => need.blocking))
      needs.push(
        inputNeed('selected', 'No recurring lines remain after opening-only products are excluded'),
      );
    return result({ orders, skipped: [...new Set(skipped)].sort() }, needs);
  },
};

const AdvanceInput = z.object({
  orderId: z.string().min(1),
  action: z.enum(['submit', 'confirm', 'receipt', 'cancel']),
  order: ReorderOrder.optional(),
  receipt: z.array(ReceiptLine).optional(),
});
const AdvanceOutput = z.object({
  orderId: z.string(),
  order: ReorderOrder,
  ifVersionHash: z.string().optional(),
});
export const advanceReorder: StepDef<typeof AdvanceInput, typeof AdvanceOutput> = {
  id: 'replenishment/advanceReorder',
  input: AdvanceInput,
  output: AdvanceOutput,
  reads: ['reorder', 'offer', 'params'],
  params: [
    {
      key: 'verify.price.tolerance',
      required: true,
      description: 'Allowed repeat price increase over initial offer price',
    },
  ],
  async run(input, ctx) {
    const stored = await ctx.assets.get(reorderSlot, input.orderId);
    // 确认前可协商单价；其它字段不可借确认动作偷换，确认后连单价也不可改。
    const withoutPrices = (order: ReorderOrder) => ({
      ...order,
      lines: order.lines.map((line) => ({ ...line, unitPrice: undefined })),
    });
    const priceChange = Boolean(
      stored &&
        !stored.redacted?.length &&
        input.order &&
        input.action === 'confirm' &&
        stored.data.state === 'submitted' &&
        (await versionHash(withoutPrices(stored.data))) ===
          (await versionHash(withoutPrices(input.order))) &&
        (await versionHash(stored.data.lines)) !== (await versionHash(input.order.lines)),
    );
    const source = priceChange ? input.order : (stored?.data ?? input.order);
    if (!source)
      return {
        output: null,
        verifications: [],
        needs: [
          {
            kind: 'asset',
            slot: 'reorder',
            filter: { field: 'id', op: 'eq', value: input.orderId },
            reason: 'Order is missing',
            blocking: true,
          },
        ],
      };
    if (stored?.redacted?.length)
      return {
        output: null,
        verifications: [],
        needs: [
          {
            kind: 'asset',
            slot: 'reorder',
            filter: { field: 'id', op: 'eq', value: input.orderId },
            reason: 'Order fields are redacted',
            blocking: true,
          },
        ],
      };
    const order = ReorderOrder.parse(structuredClone(source));
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const hash = await versionHash(order.lines);
    const validApprovals = ctx.approvals.filter(
      (approval) => Date.parse(approval.at) <= Date.parse(ctx.now),
    );
    const requireOrderApproval = (subject: string, decision: string, roles: readonly string[]) => {
      const approval = currentApproval(
        { ...ctx, approvals: validApprovals },
        'replenishment/advanceReorder',
        subject,
        hash,
      );
      // 判定与身份检查只看同一条有效批示，未来批示不能遮住当前供应商身份。
      const need = approvalNeed(
        { ...ctx, approvals: approval ? [approval] : [] },
        'replenishment/advanceReorder',
        subject,
        hash,
        decision,
        roles,
      );
      if (need) needs.push(need);
      if (
        approval?.role === 'supplier' &&
        (approval.party?.slot !== 'party' || approval.party.id !== order.supplierId)
      )
        needs.push(
          inputNeed('approval.party', 'Supplier confirmation must identify this supplier party'),
        );
      if (approval?.role === 'store' && approval.party && approval.party.id !== order.storeId)
        needs.push(inputNeed('approval.party', 'Store approval belongs to a different store'));
      return approval;
    };
    let transitionActor = ctx.actor;
    if (Date.parse(order.history.at(-1)?.at ?? ctx.now) > Date.parse(ctx.now))
      needs.push(inputNeed('now', 'Order transitions cannot precede current order history'));
    if (
      stored &&
      input.order &&
      !priceChange &&
      (await versionHash(input.order)) !== (await versionHash(stored.data))
    )
      needs.push(
        inputNeed(
          'order',
          'Stored orders must be advanced from their current version; changed lines require cancellation and a new order',
        ),
      );
    if (!stored && (input.action !== 'submit' || order.state !== 'draft'))
      needs.push(inputNeed('orderId', 'An unstored order can only be submitted from a draft'));
    if (
      order.state === 'confirmed' &&
      [...order.history].reverse().find((entry) => entry.state === 'confirmed')?.subjectHash !==
        hash
    )
      needs.push(
        inputNeed('order.lines', 'Confirmed prices are locked to the confirmation subject hash'),
      );
    const expected = { submit: 'draft', confirm: 'submitted', receipt: 'confirmed' } as const;
    if (
      input.action === 'cancel'
        ? ['delivered', 'cancelled'].includes(order.state)
        : order.state !== expected[input.action]
    )
      needs.push(inputNeed('action', 'Order transition is not permitted from this state'));
    if (
      input.action !== 'cancel' &&
      order.lines.some((line) => !line.unitPrice || line.priceSource === 'unpriced')
    )
      needs.push(inputNeed('order.lines', 'Unpriced orders cannot advance'));
    if (input.action === 'submit' || input.action === 'confirm') {
      if (priceChange) {
        requireOrderApproval(`submit:${input.orderId}`, 'submit', ['store']);
      }
      const roles = input.action === 'submit' ? ['store'] : ['supplier', 'operator'];
      const approval = requireOrderApproval(
        `${input.action}:${input.orderId}`,
        input.action,
        roles,
      );
      transitionActor = approval?.by ?? ctx.actor;
    }
    if (input.action === 'receipt') {
      if (
        !input.receipt?.length ||
        input.receipt.some((line) => !order.lines.some((ordered) => ordered.key === line.key)) ||
        new Set(input.receipt.map((line) => line.key)).size !== input.receipt.length
      )
        needs.push(inputNeed('receipt', 'Receipt must contain unique ordered keys'));
      if (input.receipt) order.receipt = input.receipt;
      if (stored && input.receipt) {
        for (const [index, line] of order.lines.entries()) {
          const qty = input.receipt.find((received) => received.key === line.key)?.qty ?? 0;
          verifications.push({
            asset: assetRef(stored, undefined, `/lines/${index}`),
            purpose: 'replenishment/advanceReorder',
            dimension: 'receiptQty',
            verdict: qty === line.qty ? 'holds' : 'fails',
            reason:
              qty === line.qty
                ? 'Received quantity equals ordered quantity'
                : 'Received quantity differs from ordered quantity',
            measured: { field: line.key, expected: line.qty, actual: qty, unit: line.unit },
            at: ctx.now,
            by: ctx.actor,
          });
        }
      }
    }
    if (needs.some((need) => need.blocking))
      return result({ orderId: input.orderId, order }, needs, verifications);
    if (input.action === 'confirm') {
      const tolerance = order.lines.some((line) => line.initialOfferRef)
        ? numericParam(ctx, 'verify.price.tolerance', needs, { min: 0 })
        : null;
      for (const line of order.lines) {
        const actual = line.unitPrice as Money;
        for (const [ref, dimension] of [
          [line.initialOfferRef, 'repeatPrice'],
          [line.priceSource === 'repeat-offer' ? line.offerRef : undefined, 'offerPrice'],
        ] as const) {
          if (!ref) continue;
          const offer = await ctx.assets.get(OfferSlot, ref.id);
          if (
            !offer ||
            (offer.versionHash !== ref.versionHash &&
              offer.fieldsetHashes?.[ref.fieldset ?? ''] !== ref.versionHash)
          ) {
            verifications.push({
              asset: ref,
              purpose: 'replenishment/advanceReorder',
              dimension,
              verdict: 'pending',
              reason: 'Referenced offer version is unavailable',
              at: ctx.now,
              by: ctx.actor,
            });
            continue;
          }
          const priceNeeds: Need[] = [];
          const expectedPrice = await linePrice(offer, line, ctx, actual.currency, {}, priceNeeds);
          const pending = !expectedPrice || (dimension === 'repeatPrice' && tolerance === null);
          const holds =
            expectedPrice &&
            (dimension === 'repeatPrice'
              ? actual.amount <= expectedPrice.amount * (1 + (tolerance ?? 0))
              : actual.amount === expectedPrice.amount);
          verifications.push({
            asset: assetRef(offer, 'price'),
            purpose: 'replenishment/advanceReorder',
            dimension,
            verdict: pending ? 'pending' : holds ? 'holds' : 'fails',
            reason: pending
              ? 'Comparison needs a compatible priced offer and exchange rate'
              : holds
                ? 'Confirmed price satisfies the offer comparison'
                : 'Confirmed price differs from the expected offer price',
            ...(expectedPrice
              ? {
                  measured: {
                    field: 'unitPrice',
                    expected: expectedPrice.amount,
                    actual: actual.amount,
                    unit: actual.currency,
                    delta: roundMoney({
                      amount: actual.amount - expectedPrice.amount,
                      currency: actual.currency,
                    }).amount,
                  },
                }
              : {}),
            at: ctx.now,
            by: ctx.actor,
          });
        }
      }
    }
    if (needs.some((need) => need.blocking))
      return result({ orderId: input.orderId, order }, needs, verifications);
    const state =
      input.action === 'submit'
        ? 'submitted'
        : input.action === 'confirm'
          ? 'confirmed'
          : input.action === 'receipt'
            ? 'delivered'
            : 'cancelled';
    order.state = state;
    order.history.push({ state, at: ctx.now, by: transitionActor, subjectHash: hash });
    return result(
      { orderId: input.orderId, order, ...(stored ? { ifVersionHash: stored.versionHash } : {}) },
      needs,
      verifications,
    );
  },
};
