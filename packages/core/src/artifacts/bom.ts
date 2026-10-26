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

const Basis = z.object({
  status: z.enum(['measured', 'estimated', 'derived', 'manual']),
  note: z.string(),
});
const Frame = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export const PriceBasis = z.enum(['model', 'quote', 'catalog', 'invoice', 'estimate']);
export const QtyRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.enum(['length', 'area']),
    demand: z.number().nonnegative(),
    lossPct: z.number().min(0),
  }),
  z.object({
    kind: z.enum(['modules', 'tiles']),
    demand: z.number().nonnegative(),
    lossPct: z.number().min(0),
    packSize: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('linked'),
    links: z.array(z.string()).min(1),
    factor: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal('site'),
    metric: z.enum(['seats', 'area', 'frontage', 'clearHeight']),
    factor: z.number().nonnegative(),
    lossPct: z.number().min(0),
  }),
  z.object({
    kind: z.literal('menu'),
    recipeId: z.string(),
    ingredientIndex: z.number().int().nonnegative(),
  }),
]);
export const Component = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.enum(['material', 'hardware', 'process', 'labor']),
  basis: z.enum(['fixed', 'length', 'area', 'front', 'side', 'volume', 'skin', 'cylinder']),
  qtyPerUnit: z.number().nonnegative(),
  unit: Unit,
  rateRef: AssetRef.optional(),
  rate: Money.optional(),
  rateNote: z.string().optional(),
  override: z.object({ rate: Money, reason: z.string().min(1) }).optional(),
});
export const Part = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.string(),
  qty: z.number(),
  unit: Unit,
  rate: Money,
  total: Money,
  note: z.string(),
});
export const BomLine = LineItem.extend({
  category: z.string(),
  name: z.string().min(1),
  zone: z.string(),
  spec: z.string(),
  dimensionsMm: z.object({ l: z.number(), w: z.number(), h: z.number() }).optional(),
  qtyRule: QtyRule,
  qtyBasis: Basis,
  dimsBasis: Basis,
  budgetKey: BudgetKey,
  evidence: z.array(z.object({ image: AssetRef, frame: Frame.optional(), note: z.string() })),
  derivedFrom: z.object({ kind: z.enum(['image', 'case', 'menu', 'manual']), ref: z.string() }),
  pricingMode: z.enum(['custom', 'whole']),
  components: z.array(Component),
  wholeEstimate: z
    .object({ unit: Money, basis: PriceBasis.exclude(['model']), ref: AssetRef.optional() })
    .optional(),
  modelCostPerUnit: Money.nullable(),
  parts: z.array(Part),
  modelWarnings: z.array(z.string()),
  sourcing: z
    .object({
      partyId: AssetId,
      offerPrice: Money,
      tierMinQty: z.number(),
      incoterm: z.string().optional(),
      includes: z.array(z.enum(['pack', 'freight', 'install', 'tax'])),
      quotedAt: IsoDate,
      validUntil: IsoDate.optional(),
      leadTimeDays: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
    })
    .nullable(),
  costBasis: z.enum(['model', 'offer']),
  unitPrice: Money.extend({ basis: PriceBasis }),
  installKind: z.enum(['loose', 'fixed']).optional(),
  volumePerUnit: z.number().positive().optional(),
  urgent: z.boolean().optional(),
  orderedAt: IsoDate.optional(),
  coverDays: z.number().positive().optional(),
});
const Sum = z.object({ model: Money, chosen: Money, sourcedShare: z.number().min(0).max(1) });
export const BomBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(BomLine).max(2000),
  totals: z.object({ model: Money, chosen: Money, byBudgetKey: z.partialRecord(BudgetKey, Sum) }),
});
export const MenuPlan = z.object({
  menuRef: AssetRef,
  coverDays: z.number().positive(),
  items: z.array(
    z.object({
      menuItemId: z.string(),
      recipeRef: AssetRef,
      servingsPerDay: z.number().nonnegative(),
    }),
  ),
});
