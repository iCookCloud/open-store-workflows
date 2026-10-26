import { AssetRef, Hash, IsoDateTime, LineItem, Money, defineSlot, z } from '@osw/core';

export const ReorderLine = LineItem.extend({
  productRef: AssetRef.refine(
    (ref) => ref.slot === 'product',
    'Product reference must use product slot',
  ).optional(),
  offerRef: AssetRef.refine(
    (ref) => ref.slot === 'offer',
    'Offer reference must use offer slot',
  ).optional(),
  lineKind: z.enum(['food', 'supplies']),
  qty: z.number().positive(),
  key: z.string().min(1),
  weakKey: z.boolean(),
  name: z.string().min(1),
  spec: z.string(),
  unitPrice: Money.refine((money) => money.amount >= 0, 'Unit price cannot be negative').optional(),
  priceSource: z.enum(['repeat-offer', 'last-paid', 'unpriced']),
  initialOfferRef: AssetRef.refine(
    (ref) => ref.slot === 'offer',
    'Initial offer reference must use offer slot',
  ).optional(),
  coverDays: z.number().positive().optional(),
});
export type ReorderLine = z.infer<typeof ReorderLine>;
export const OrderState = z.enum(['draft', 'submitted', 'confirmed', 'delivered', 'cancelled']);
export const ReceiptLine = z.object({ key: z.string().min(1), qty: z.number().nonnegative() });
export const ReorderOrder = z
  .object({
    storeId: z.string().min(1),
    supplierId: z.string().min(1),
    lines: z.array(ReorderLine).min(1),
    skipped: z.array(z.string()),
    state: OrderState,
    history: z
      .array(
        z.object({
          state: OrderState,
          at: IsoDateTime,
          by: z.string().min(1),
          subjectHash: Hash.optional(),
        }),
      )
      .min(1),
    attribution: z
      .object({
        campaignId: z.string().min(1),
        variantKey: z.string().min(1),
        how: z.enum(['link', 'window']),
      })
      .optional(),
    receipt: z.array(ReceiptLine).optional(),
  })
  .superRefine((order, ctx) => {
    if (new Set(order.lines.map((line) => line.key)).size !== order.lines.length)
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Order line keys must be unique' });
    if (order.history.at(-1)?.state !== order.state)
      ctx.addIssue({
        code: 'custom',
        path: ['history'],
        message: 'History must end at current state',
      });
    if (
      order.receipt &&
      new Set(order.receipt.map((line) => line.key)).size !== order.receipt.length
    )
      ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'Receipt keys must be unique' });
  });
export type ReorderOrder = z.infer<typeof ReorderOrder>;
export const FrequentLine = ReorderLine.extend({
  supplierId: z.string().optional(),
  lastAt: IsoDateTime.nullable(),
  lastPaid: Money.optional(),
  dueAt: IsoDateTime.nullable(),
  overdue: z.boolean(),
  orderCount: z.number().int().nonnegative(),
});
export type FrequentLine = z.infer<typeof FrequentLine>;
export const reorderSlot = defineSlot({
  name: 'reorder',
  schema: ReorderOrder,
  filterable: {
    storeId: ['eq', 'in'],
    supplierId: ['eq', 'in'],
    state: ['eq', 'in'],
    'attribution.campaignId': ['eq', 'in'],
  },
  sortable: ['storeId', 'supplierId'],
});

export function lineKey(line: Pick<ReorderLine, 'productRef' | 'name' | 'spec' | 'unit'>): string {
  return line.productRef?.id ?? `weak:${JSON.stringify([line.name, line.spec, line.unit])}`;
}
export function orderPlacedAt(order: ReorderOrder): string {
  return order.history.find((entry) => entry.state === 'submitted')?.at ?? order.history[0].at;
}
