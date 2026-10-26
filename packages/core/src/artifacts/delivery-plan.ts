import {
  Address,
  AssetId,
  AssetRef,
  FillSrc,
  GeoPoint,
  Hash,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
  LineItem,
  Measure,
  Money,
  ParamKey,
  TrackKey,
  Unit,
  z,
} from '../base.js';
import { BudgetKey } from '../budget.js';
import { ConditionKey, ConditionReading, Requirement } from '../conditions.js';
import { FilterSchema } from '../filter.js';
import { ArtifactRef } from './envelope.js';
const Level = z.enum(['entity', 'batch', 'sku']);
const ComplianceEntry = z.object({
  productRef: AssetRef,
  market: Jurisdiction,
  categoryId: z.string().nullable(),
  tree: z.enum([
    'ok',
    'unclassified',
    'missing_category',
    'missing_parent',
    'cycle',
    'too_deep',
    'cross_market',
    'item_market_mismatch',
  ]),
  items: z.array(
    z.object({
      itemRootId: z.string(),
      level: Level,
      required: z.enum(['mandatory', 'advisory']),
      state: z.enum(['cited', 'not_in_materials', 'pending_review', 'unanswered', 'expired']),
      evidence: z.array(z.string()),
    }),
  ),
  open: z.object({ mandatory: z.number().int(), advisory: z.number().int() }),
  orphans: z.array(z.string()),
  subjectHash: Hash,
  conclusion: z.enum(['enter', 'special_review', 'deny', 'undecided']),
});
const GoodsClass = z.enum(['food', 'nonfood']);
const cell = <T extends z.ZodTypeAny>(v: T) =>
  z.object({
    value: v.nullable(),
    src: FillSrc.nullable(),
    by: z.enum(['operator', 'forwarder', 'store']).optional(),
  });
const Mode = z.enum(['sea_fcl', 'sea_lcl', 'air', 'ground']);
const Node = z.enum(['depart', 'transit', 'arrived', 'customs', 'final_mile', 'delivered']);
const PackingLine = z.object({
  id: z.string(),
  bomLineId: z.string(),
  lineKind: LineItem.shape.lineKind,
  productRef: AssetRef.optional(),
  offerRef: AssetRef,
  name: z.string(),
  spec: z.string(),
  qty: z.number().positive(),
  goodsClass: GoodsClass,
  goodsClassSrc: FillSrc,
  hsCode: cell(z.string()),
  materialText: cell(z.string()),
  netWeightKg: cell(z.number().positive()),
  cartonUnits: cell(z.number().int().positive()),
  cartons: cell(z.number().int().positive()),
  totalNetWeightKg: cell(z.number().positive()),
  totalGrossWeightKg: cell(z.number().positive()),
  totalVolumeM3: cell(z.number().positive()),
  declaredValue: Money,
});
const FreightQuote = z.object({
  id: z.string(),
  partyRef: AssetRef,
  form: z.enum(['lump_sum', 'itemized']),
  items: z
    .array(
      z.object({
        category: z.enum([
          'origin_haulage',
          'main_freight',
          'destination_charges',
          'customs_duty',
          'warehouse',
          'labeling',
          'final_delivery',
          'other',
        ]),
        amount: Money,
      }),
    )
    .min(1),
  terms: z.string(),
  transitDays: z.number().int().positive().nullable(),
  validUntil: IsoDate.nullable(),
  receivedAt: IsoDateTime,
});
const ArrivalRecord = z.object({
  receivedAt: IsoDate,
  by: z.string(),
  evidence: z.array(z.string()),
  lines: z.array(
    z.object({
      lineId: z.string(),
      receivedQty: z.number().nonnegative(),
      damagedQty: z.number().nonnegative(),
      cartons: z.number().int().nonnegative().nullable(),
      measuredGrossWeightKg: z.number().positive().nullable(),
      measuredVolumeM3: z.number().positive().nullable(),
      note: z.string(),
    }),
  ),
  observedLoadingAccess: z.string().nullable(),
});
const Shipment = z.object({
  id: z.string(),
  origin: Jurisdiction,
  goodsClass: GoodsClass,
  mode: Mode,
  crossBorder: z.boolean(),
  status: z.enum(['draft', 'confirmed', 'quoting', 'booked', 'shipped', 'received']),
  node: Node.nullable(),
  consignee: z
    .object({
      jurisdiction: Jurisdiction,
      company: z.string(),
      address: z.string(),
      name: z.string(),
      phone: z.string(),
      email: z.string(),
    })
    .partial(),
  portFrom: z.string().nullable(),
  portTo: z.string().nullable(),
  lastMile: z.array(z.enum(['liftgate', 'small_vehicle'])),
  carrier: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('forwarder'), partyRef: AssetRef }),
    z.object({ kind: z.literal('own'), name: z.string(), contact: z.string() }),
    z.object({ kind: z.literal('seller'), partyRef: AssetRef }),
    z.object({ kind: z.literal('unassigned') }),
  ]),
  lines: z.array(PackingLine),
  quotes: z.array(FreightQuote),
  chosenQuoteId: z.string().nullable(),
  freight: Money.nullable(),
  documents: z.array(
    z.object({
      itemRootId: z.string(),
      productRefs: z.array(AssetRef),
      state: z.enum(['cited', 'not_in_materials', 'pending_review', 'unanswered']),
      evidence: z.array(z.string()),
    }),
  ),
  tracking: z
    .object({
      blNo: z.string(),
      containerNo: z.string(),
      etd: IsoDate,
      eta: IsoDate,
      departedAt: IsoDate,
      deliveredAt: IsoDate,
    })
    .partial(),
  holds: z.array(z.object({ at: IsoDateTime, reason: z.string(), lineIds: z.array(z.string()) })),
  arrival: ArrivalRecord.nullable(),
  amendments: z.array(
    z.object({
      field: z.string(),
      lineId: z.string().nullable(),
      before: z.unknown(),
      after: z.unknown(),
      reason: z.string().min(1),
      by: z.string(),
      at: IsoDateTime,
    }),
  ),
});
const Basis = z.enum(['received', 'delivered', 'eta', 'none']);
const Milestone = z.object({
  date: IsoDate.nullable(),
  basis: Basis,
  shipmentIds: z.array(z.string()),
});
export const DeliveryPlanBody = z.object({
  market: Jurisdiction,
  compliance: z.array(ComplianceEntry),
  held: z.array(
    z.object({
      bomLineId: z.string(),
      detail: z.string(),
      reason: z.enum([
        'no_offer',
        'compliance_deny',
        'compliance_pending',
        'unit_unconvertible',
        'fx_unverified',
        'goods_mismatch',
      ]),
    }),
  ),
  shipments: z.array(Shipment),
  arrivals: z.array(
    z.object({
      bomLineId: z.string(),
      shipmentId: z.string(),
      qty: z.number(),
      basis: Basis,
      eta: IsoDate.nullable(),
      arrivedAt: IsoDate.nullable(),
      receivedQty: z.number().nullable(),
      damagedQty: z.number().nullable(),
    }),
  ),
  fitoutGoodsLastAt: Milestone,
  openingStock: z.object({
    status: z.enum(['none', 'planned', 'in_transit', 'delivered', 'received']),
    firstAt: Milestone,
    lastAt: Milestone,
  }),
  allReceived: z.boolean(),
});
