import {
  Address,
  Currency,
  GeoPoint,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
  LocalizedText,
  Money,
  ParamKey,
  Quantity,
  TermRef,
  TrackKey,
  Unit,
  z,
} from '../base.js';
import { BudgetKey } from '../budget.js';
import { defineSlot } from '../slot.js';
const Strings = z.array(z.string());
const eqin = ['eq', 'in'] as const;
const dims = z.object({
  l: z.number().positive(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export const Product = z.object({
  name: LocalizedText,
  kind: z.enum(['catalog', 'custom']),
  category: z.string(),
  goodsClass: z.enum(['food', 'nonfood']),
  status: z.enum(['active', 'discontinued']),
  sku: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  spec: z.string().optional(),
  materials: z
    .array(
      z.object({
        part: z.string().optional(),
        material: z.string(),
        share: z.number().min(0).max(1).optional(),
      }),
    )
    .optional(),
  dimensionsMm: dims.optional(),
  netWeightKg: z.number().positive().optional(),
  grossWeightKg: z.number().positive().optional(),
  unitVolumeM3: z.number().positive().optional(),
  carton: z
    .object({
      units: z.number().int().positive(),
      grossWeightKg: z.number().positive(),
      lMm: z.number().positive(),
      wMm: z.number().positive(),
      hMm: z.number().positive(),
    })
    // 箱规逐项实测与补空；未知尺寸不能阻止已核实的装箱数、毛重入库。
    .partial()
    .optional(),
  hsCode: z
    .string()
    .regex(/^\d{6,10}$/)
    .optional(),
  customsMaterial: z.string().optional(),
  originCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  handlingTags: Strings.optional(),
  storage: z.enum(['ambient', 'chilled', 'frozen']).optional(),
  shelfLifeDays: z.number().int().positive().optional(),
  utilities: z
    .object({
      powerKw: z.number().nonnegative().optional(),
      voltageV: z.number().positive().optional(),
      phase: z.number().int().positive().optional(),
      gas: z.boolean().optional(),
      water: z.boolean().optional(),
      drain: z.boolean().optional(),
      exhaust: z.boolean().optional(),
    })
    .optional(),
  certifications: Strings.optional(),
  images: Strings.optional(),
});
export type Product = z.infer<typeof Product>;
export const ProductSlot = defineSlot({
  name: 'product',
  slotVersion: '0.2.0',
  schema: Product,
  fieldsets: {
    identity: [
      'name',
      'kind',
      'category',
      'sku',
      'brand',
      'model',
      'spec',
      'materials',
      'dimensionsMm',
      'goodsClass',
      'status',
    ],
    logistics: [
      'netWeightKg',
      'grossWeightKg',
      'unitVolumeM3',
      'carton',
      'hsCode',
      'customsMaterial',
      'originCountry',
      'handlingTags',
      'storage',
      'shelfLifeDays',
      'certifications',
    ],
    images: ['images'],
  },
  filterable: {
    sku: eqin,
    category: eqin,
    kind: eqin,
    status: eqin,
    goodsClass: eqin,
    originCountry: eqin,
    hsCode: ['eq', 'in', 'exists'],
    handlingTags: ['hasAny'],
    name: ['contains'],
  },
  sortable: ['sku', 'category', 'name'],
});
export const SupplierProfile = z.object({
  supplyCats: Strings,
  acceptsSmallOrders: z.boolean().optional(),
});
export const ForwarderProfile = z.object({
  rank: z.number().nonnegative(),
  goodsClasses: z.array(z.enum(['food', 'nonfood'])),
  lanes: z.array(z.object({ from: Jurisdiction, to: Jurisdiction, modes: Strings })),
  handling: Strings,
});
export const ContractorProfile = z.object({
  trades: Strings,
  licenses: z.array(
    z.object({ kind: z.string(), jurisdiction: Jurisdiction, expiresAt: IsoDate.optional() }),
  ),
  insuranceExpiresAt: IsoDate.optional(),
  crewSize: z.number().int().positive().optional(),
});
export const LawyerProfile = z.object({
  matters: Strings,
  stance: z.enum(['tenant', 'landlord', 'employer', 'employee', 'mixed']),
  caseTypes: Strings,
  teamSize: z.number().int().positive().optional(),
  since: z.number().int().optional(),
  chinaLanding: z.enum(['own', 'partner', 'none']),
  engagement: z.array(z.enum(['retainer', 'matter', 'batch', 'contingency', 'negotiable'])),
});
export const CreatorProfile = z.object({
  platform: z.string(),
  tier: z.string(),
  audience: z.number().nonnegative(),
  formats: Strings,
  engagementPct: z.number().min(0).max(100),
  lastPostOn: IsoDate,
  verifiedOn: IsoDate,
  dealTier: z.string().optional(),
});
export const Party = z.object({
  name: LocalizedText,
  roles: z
    .array(
      z.enum([
        'supplier',
        'manufacturer',
        'forwarder',
        'contractor',
        'installer',
        'lawyer',
        'creator',
        'broker',
        'landlord',
        'customsBroker',
        'trainer',
      ]),
    )
    .min(1),
  status: z.enum(['active', 'standby', 'retired']),
  jurisdictions: z.array(Jurisdiction).optional(),
  base: z
    .object({ jurisdiction: Jurisdiction, city: z.string().optional(), geo: GeoPoint.optional() })
    .optional(),
  tracks: z.array(TrackKey).optional(),
  languages: Strings.optional(),
  contact: z
    .array(z.object({ kind: z.string(), value: z.string(), label: z.string().optional() }))
    .optional(),
  profiles: z
    .object({
      supplier: SupplierProfile.optional(),
      forwarder: ForwarderProfile.optional(),
      contractor: ContractorProfile.optional(),
      lawyer: LawyerProfile.optional(),
      creator: CreatorProfile.optional(),
    })
    .optional(),
});
export type Party = z.infer<typeof Party>;
export const PartySlot = defineSlot({
  name: 'party',
  schema: Party,
  filterable: {
    roles: ['hasAny'],
    jurisdictions: ['hasAny', 'exists'],
    tracks: ['hasAny'],
    status: eqin,
    'base.geo': ['within'],
    'profiles.supplier.supplyCats': ['hasAny'],
    'profiles.contractor.trades': ['hasAny'],
    'profiles.lawyer.matters': ['hasAny'],
    'profiles.forwarder.goodsClasses': ['hasAny'],
    'profiles.forwarder.handling': ['hasAll'],
    'profiles.forwarder.lanes[].from': eqin,
    'profiles.lawyer.stance': eqin,
    'profiles.creator.tier': eqin,
    'profiles.creator.engagementPct': ['gte'],
    'profiles.creator.lastPostOn': ['gte'],
  },
  sortable: ['status', 'profiles.creator.engagementPct', 'profiles.creator.lastPostOn'],
});
export const Offer = z.object({
  partyId: z.string(),
  productId: z.string().optional(),
  serviceScope: z.string().optional(),
  basis: z.enum(['quote', 'catalog', 'invoice', 'estimate']),
  use: z.enum(['project', 'repeat']),
  currency: Currency,
  unit: Unit,
  tiers: z
    .array(z.object({ minQty: z.number().nonnegative(), unitPrice: z.number().nonnegative() }))
    .min(1),
  quotedAt: IsoDate,
  includes: z.array(z.enum(['pack', 'freight', 'install', 'tax'])).optional(),
  moq: z.number().positive().optional(),
  incoterm: z.string().optional(),
  incotermPlace: z.string().optional(),
  shipFrom: Jurisdiction.optional(),
  delivery: z.enum(['buyer_arranges', 'seller_delivers']).optional(),
  serviceLineRefs: Strings.optional(),
  hoursPerUnit: z.number().nonnegative().optional(),
  validFrom: IsoDate.optional(),
  validUntil: IsoDate.optional(),
  leadTimeDays: z
    .object({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
    .optional(),
});
export type Offer = z.infer<typeof Offer>;
export function validateOffer(v: Offer): void {
  if (Boolean(v.productId) === Boolean(v.serviceScope))
    throw new Error('Offer requires productId or serviceScope exclusively');
  if (v.tiers.some((t, i) => i > 0 && t.minQty <= v.tiers[i - 1].minQty))
    throw new Error('Tier quantities must ascend');
  if (v.leadTimeDays && v.leadTimeDays.min > v.leadTimeDays.max)
    throw new Error('Invalid lead time interval');
  if (v.validFrom && v.validUntil && v.validFrom > v.validUntil)
    throw new Error('Invalid offer validity');
  if (Boolean(v.incoterm) !== Boolean(v.incotermPlace)) throw new Error('Incoterm place required');
}
export const OfferSlot = defineSlot({
  name: 'offer',
  schema: Offer,
  validate: validateOffer,
  fieldsets: {
    price: ['currency', 'unit', 'tiers', 'basis', 'use'],
    terms: [
      'includes',
      'moq',
      'incoterm',
      'incotermPlace',
      'shipFrom',
      'delivery',
      'quotedAt',
      'validFrom',
      'validUntil',
      'leadTimeDays',
    ],
  },
  filterable: {
    partyId: eqin,
    productId: eqin,
    serviceScope: eqin,
    basis: eqin,
    use: eqin,
    currency: ['eq'],
    quotedAt: ['gte', 'lte'],
    validUntil: ['gte'],
  },
  sortable: ['quotedAt', 'validUntil'],
});
export function unitPriceAt(offer: Offer, qty: number): Money | null {
  validateOffer(offer);
  if (!Number.isFinite(qty) || qty < 0) throw new Error('Invalid quantity');
  if (offer.moq !== undefined && qty < offer.moq) return null;
  const tier = offer.tiers.filter((t) => t.minQty <= qty).at(-1);
  return tier ? { amount: tier.unitPrice, currency: offer.currency } : null;
}
export const Param = z.object({
  key: ParamKey,
  value: z.union([z.number().finite(), z.string(), z.boolean()]),
  unit: z.string().optional(),
  appliesTo: z
    .object({
      jurisdictions: z.array(Jurisdiction).optional(),
      tracks: z.array(TrackKey).optional(),
    })
    .optional(),
  validFrom: IsoDate.optional(),
  validTo: IsoDate.optional(),
  note: z.string().optional(),
});
export type Param = z.infer<typeof Param>;
export const ParamsSlot = defineSlot({
  name: 'params',
  schema: Param,
  filterable: { key: eqin },
  sortable: ['key', 'validFrom'],
  validate: (v) => {
    if (v.validFrom && v.validTo && v.validFrom > v.validTo)
      throw new Error('Invalid parameter validity');
  },
});
export const ParamSlot = ParamsSlot;
export const Store = z.object({
  name: LocalizedText,
  status: z.enum(['preparing', 'operating', 'closed']),
  track: TrackKey,
  jurisdiction: Jurisdiction,
  timezone: z.string().min(1),
  origin: z.enum(['opened', 'intake']).optional(),
  openedAt: IsoDate.optional(),
  closedAt: IsoDate.optional(),
  storeType: z.string().optional(),
  cuisine: z.string().optional(),
  city: z.string().optional(),
  address: Address.optional(),
  geo: GeoPoint.optional(),
  areaM2: z.number().positive().optional(),
  seats: z.number().int().nonnegative().optional(),
  supplyCategories: Strings.optional(),
  menuIds: Strings.optional(),
  actuals: z
    .array(
      z.object({
        key: BudgetKey,
        amount: Money,
        basis: z.enum(['committed', 'paid']),
        at: IsoDateTime,
      }),
    )
    .optional(),
});
export type Store = z.infer<typeof Store>;
export const StoreSlot = defineSlot({
  name: 'store',
  schema: Store,
  filterable: {
    status: eqin,
    track: eqin,
    storeType: eqin,
    cuisine: eqin,
    origin: eqin,
    jurisdiction: ['eq', 'in', 'prefix'],
    geo: ['within'],
    supplyCategories: ['hasAny'],
    openedAt: ['gte', 'lte'],
  },
  sortable: ['openedAt', 'jurisdiction', 'track'],
});
export const MenuDerives = z.object({
  ingredients: z.array(TermRef),
  equipment: z.array(TermRef),
  sop: z.array(TermRef),
  coldchain: z.boolean(),
});
export const Menu = z.object({
  title: LocalizedText,
  cuisine: z.string(),
  tracks: z.array(TrackKey),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        name: LocalizedText,
        category: z.string().optional(),
        price: Money.optional(),
        recipeId: z.string().optional(),
        station: z.string().optional(),
      }),
    )
    .optional(),
  origin: z.enum(['delivered', 'reference']).optional(),
  stations: Strings.optional(),
  pageCount: z.number().int().positive().optional(),
  pages: Strings.optional(),
  derives: MenuDerives.optional(),
});
export type Menu = z.infer<typeof Menu>;
export const MenuSlot = defineSlot({
  name: 'menu',
  schema: Menu,
  filterable: { cuisine: eqin, origin: eqin, tracks: ['hasAny'] },
  sortable: ['pageCount', 'origin'],
  validate: (v) => {
    if (v.items && new Set(v.items.map((x) => x.id)).size !== v.items.length)
      throw new Error('Menu item ids must be unique');
  },
});
export const Recipe = z.object({
  name: LocalizedText,
  yield: Quantity,
  ingredients: z.array(
    z.object({
      productId: z.string().optional(),
      termKey: z.string().optional(),
      qty: z.number().nonnegative(),
      unit: Unit,
      netQty: z.number().nonnegative().optional(),
      prep: z.string().optional(),
    }),
  ),
  menuItemIds: Strings.optional(),
  station: z.string().optional(),
  sopRef: z.string().optional(),
});
export type Recipe = z.infer<typeof Recipe>;
export const RecipeSlot = defineSlot({
  name: 'recipe',
  schema: Recipe,
  filterable: { menuItemIds: ['hasAny'] },
  validate: (v) => {
    if (v.ingredients.some((i) => Boolean(i.productId) === Boolean(i.termKey)))
      throw new Error('Ingredient requires productId or termKey exclusively');
  },
});
export const Term = z.object({
  key: z.string().min(1),
  kind: z.enum(['ingredient', 'equipment', 'sop', 'supplyCategory', 'cuisine']),
  labels: LocalizedText,
  parent: z.string().optional(),
});
export type Term = z.infer<typeof Term>;
export const TermSlot = defineSlot({
  name: 'term',
  schema: Term,
  filterable: { key: eqin, kind: eqin },
  sortable: ['key'],
});
export const Template = z.object({
  kind: z.string(),
  lang: z.string(),
  title: LocalizedText,
  format: z.enum(['markdown', 'json']),
  jurisdiction: Jurisdiction.optional(),
  body: z.string().optional(),
  content: z.unknown().optional(),
  placeholders: z
    .array(
      z.object({
        token: z.string(),
        key: z.string(),
        label: z.string().optional(),
        required: z.boolean(),
      }),
    )
    .optional(),
  sections: z.array(z.object({ key: z.string(), title: z.string(), must: z.boolean() })).optional(),
  reviewPoints: Strings.optional(),
  termKeys: Strings.optional(),
  requiresCounselReview: z.boolean().optional(),
});
export type Template = z.infer<typeof Template>;
export const TemplateSlot = defineSlot({
  name: 'template',
  schema: Template,
  filterable: { kind: eqin, jurisdiction: eqin, lang: eqin },
  validate: (v) => {
    if (
      (v.format === 'markdown' && v.body === undefined) ||
      (v.format === 'json' && v.content === undefined)
    )
      throw new Error('Template content missing for format');
  },
});
export const SHARED_SLOTS = [
  ProductSlot,
  PartySlot,
  OfferSlot,
  ParamsSlot,
  StoreSlot,
  MenuSlot,
  RecipeSlot,
  TermSlot,
  TemplateSlot,
];
export const productSlot = ProductSlot,
  partySlot = PartySlot,
  offerSlot = OfferSlot,
  paramsSlot = ParamsSlot,
  storeSlot = StoreSlot,
  menuSlot = MenuSlot,
  recipeSlot = RecipeSlot,
  termSlot = TermSlot,
  templateSlot = TemplateSlot;
