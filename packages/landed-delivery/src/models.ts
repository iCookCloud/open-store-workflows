import {
  ArtifactEnvelope,
  AssetRef,
  BomBody,
  DeliveryPlanBody,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
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
export const DeliveryInput = z.object({
  id: z.string().min(1).max(128),
  jurisdiction: Jurisdiction,
  bom: Bom,
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
});
export type DeliveryInput = z.infer<typeof DeliveryInput>;
export const DeliveryState = z.object({
  input: DeliveryInput,
  plan: DeliveryPlanBody,
  sources: z.array(AssetRef),
  example: z.boolean(),
  candidates: z.record(z.string(), z.array(AssetRef)).default({}),
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
      input.bom.example === true &&
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
