import {
  ArtifactEnvelope,
  AssetRef,
  BomBody,
  DeliveryPlanBody,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
  LineItem,
  Measure,
  Money,
  SiteDecisionBody,
  z,
} from '@osw/core';

// 所有交接结构直接引用 core，避免生产方与消费方各自维护一份契约。
export const Shipment = DeliveryPlanBody.shape.shipments.element;
export type Shipment = z.infer<typeof Shipment>;
export const PackingLine = Shipment.shape.lines.element;
export type PackingLine = z.infer<typeof PackingLine>;
export const FreightQuote = Shipment.shape.quotes.element;
export type FreightQuote = z.infer<typeof FreightQuote>;
export const ArrivalRecord = Shipment.shape.arrival.unwrap();
export const ComplianceEntry = DeliveryPlanBody.shape.compliance.element;
export type ComplianceEntry = z.infer<typeof ComplianceEntry>;
export const DeliveryPlan = ArtifactEnvelope('DeliveryPlan', DeliveryPlanBody);
export const Bom = ArtifactEnvelope('Bom', BomBody);
export const SiteDecision = ArtifactEnvelope('SiteDecision', SiteDecisionBody);
export const CarrierSelection = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forwarder'),
    partyId: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('own'),
    name: z.string().min(1),
    contact: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('seller'), reason: z.string().min(1).optional() }),
]);
export const PartyEdit = z.object({
  role: z.enum(['operator', 'forwarder', 'own', 'client']),
  lineId: z.string().optional(),
  field: z.string().min(1),
  value: z.unknown(),
  reason: z.string().optional(),
});
export const CarrierUpdate = z.object({
  node: Shipment.shape.node.unwrap().optional(),
  tracking: Shipment.shape.tracking.optional(),
  hold: z
    .object({
      reason: z.string().min(1),
      lineIds: z.array(z.string()).min(1),
      itemRootId: z.string().optional(),
    })
    .optional(),
  cleared: z.boolean().optional(),
  at: IsoDateTime,
});
// 只收 core 的物料行；复购流程的内部状态与价格来源不属于运输入口。
export const ReorderInput = z
  .object({
    id: z.string().min(1).max(128),
    lines: z
      .array(
        LineItem.extend({
          qty: z.number().positive(),
          offerRef: AssetRef.refine((ref) => ref.slot === 'offer', 'Expected offer reference'),
          productRef: AssetRef.refine(
            (ref) => ref.slot === 'product',
            'Expected product reference',
          ).optional(),
        }),
      )
      .min(1)
      .max(2000),
    mode: Shipment.shape.mode,
    orderedAt: IsoDate.optional(),
    loadingAccess: Measure.optional(),
    sourceRef: AssetRef.refine(
      (ref) => ref.slot === 'reorder',
      'Expected reorder reference',
    ).optional(),
    example: z.literal(true).optional(),
  })
  .superRefine((order, ctx) => {
    if (new Set(order.lines.map((line) => line.id)).size !== order.lines.length)
      ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Order line IDs must be unique' });
    if (order.sourceRef && order.sourceRef.id !== order.id)
      ctx.addIssue({
        code: 'custom',
        path: ['sourceRef'],
        message: 'Order source reference must identify this order',
      });
  });
export type ReorderInput = z.infer<typeof ReorderInput>;
// 这是运输过程需要的已解析行，不是伪造的 Bom 产出物。
export const DeliverySourceLine = LineItem.extend({
  name: z.string().min(1),
  spec: z.string(),
  category: z.string(),
  unitPrice: Money,
  urgent: z.boolean().optional(),
  orderedAt: IsoDate.optional(),
});
export type DeliverySourceLine = z.infer<typeof DeliverySourceLine>;
export const DeliveryInput = z
  .object({
    id: z.string().min(1).max(128),
    jurisdiction: Jurisdiction,
    bom: Bom.optional(),
    reorder: ReorderInput.optional(),
    site: SiteDecision.optional(),
    expectedArrival: IsoDate.optional(),
    importerRef: AssetRef.optional(),
    existing: DeliveryPlan.optional(),
    consignee: Shipment.shape.consignee.optional(),
    portTo: z.string().optional(),
    carriers: z.record(z.string(), CarrierSelection).default({}),
    edits: z.record(z.string(), z.array(PartyEdit)).default({}),
    quotes: z.record(z.string(), z.array(FreightQuote)).default({}),
    updates: z.record(z.string(), z.array(CarrierUpdate)).default({}),
    arrivals: z.record(z.string(), ArrivalRecord).default({}),
  })
  .superRefine((input, ctx) => {
    if (Boolean(input.bom) === Boolean(input.reorder))
      ctx.addIssue({
        code: 'custom',
        path: ['bom'],
        message: 'Provide exactly one packing source: bom or reorder',
      });
    if (!input.reorder) return;
    if (input.site)
      ctx.addIssue({
        code: 'custom',
        path: ['site'],
        message:
          'Warehouse delivery uses consignee and reorder.loadingAccess instead of a store SiteDecision',
      });
    for (const field of ['jurisdiction', 'company', 'address', 'name', 'phone'] as const)
      if (!input.consignee?.[field]?.trim())
        ctx.addIssue({
          code: 'custom',
          path: ['consignee', field],
          message: 'Warehouse consignee field is required',
        });
    if (input.consignee?.jurisdiction && input.consignee.jurisdiction !== input.jurisdiction)
      ctx.addIssue({
        code: 'custom',
        path: ['consignee', 'jurisdiction'],
        message: 'Warehouse and destination jurisdictions must match',
      });
  });
export type DeliveryInput = z.infer<typeof DeliveryInput>;
export const DeliveryState = z
  .object({
    input: DeliveryInput,
    plan: DeliveryPlanBody,
    sources: z.array(AssetRef),
    example: z.boolean(),
    candidates: z.record(z.string(), z.array(AssetRef)).default({}),
    orderLines: z.array(DeliverySourceLine).optional(),
  })
  .superRefine((state, ctx) => {
    if (!state.input.reorder) return;
    if (
      !state.orderLines ||
      state.orderLines.length !== state.input.reorder.lines.length ||
      new Set(state.orderLines.map((line) => line.id)).size !== state.orderLines.length ||
      state.orderLines.some(
        (line) =>
          !state.input.reorder!.lines.some(
            (source) =>
              source.id === line.id &&
              source.qty === line.qty &&
              source.unit === line.unit &&
              source.offerRef.id === line.offerRef?.id,
          ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['orderLines'],
        message: 'Resolved order lines must match the source; run screenCompliance first',
      });
  });
export type DeliveryState = z.infer<typeof DeliveryState>;
export const emptyMilestone = () => ({
  date: null,
  basis: 'none' as const,
  shipmentIds: [] as string[],
});
export function initialState(input: DeliveryInput): DeliveryState {
  return {
    input,
    sources: [],
    example:
      (input.bom?.example ?? input.reorder?.example) === true &&
      (!input.site || input.site.example === true) &&
      (!input.existing || input.existing.example === true),
    candidates: {},
    plan: {
      market: input.jurisdiction.split('-')[0],
      compliance: [],
      held: [],
      shipments: input.existing?.body.shipments ?? [],
      arrivals: [],
      fitoutGoodsLastAt: emptyMilestone(),
      openingStock: { status: 'none', firstAt: emptyMilestone(), lastAt: emptyMilestone() },
      allReceived: false,
    },
  };
}
