import {
  ArtifactRef,
  AssetRef,
  BomLine,
  BudgetKey,
  Component,
  Currency,
  DimensionsMm,
  Frame,
  Hash,
  IsoDate,
  Jurisdiction,
  LineItem,
  Money,
  TrackKey,
  Unit,
  z,
} from '@osw/core';

export const BomDraft = z
  .object({
    currency: Currency,
    context: z.object({ jurisdiction: Jurisdiction, track: TrackKey }).optional(),
    lines: z.array(BomLine).max(2000),
    sources: z.array(AssetRef),
    inputs: z.array(ArtifactRef),
    storeId: z.string().nullable(),
    example: z.literal(true).optional(),
  })
  .refine((v) => new Set(v.lines.map((l) => l.id)).size === v.lines.length, {
    path: ['lines'],
    message: 'Line IDs must be unique',
  });
export type BomDraft = z.infer<typeof BomDraft>;
export { MenuPlan } from '@osw/core';
export const ItemCandidate = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  zone: z.string(),
  spec: z.string(),
  lineKind: LineItem.shape.lineKind,
  pricingMode: z.enum(['custom', 'whole']),
  dimensionsMm: DimensionsMm.optional(),
  qty: z.number().nonnegative().max(1e8),
  unit: Unit,
  componentsHint: z.array(z.object({ name: z.string(), kind: Component.shape.kind })).max(8),
  evidence: z
    .array(z.object({ imageIndex: z.number().int().nonnegative(), frame: Frame.optional() }))
    .min(1),
  estimated: z.object({ dims: z.boolean(), qty: z.boolean() }),
  note: z.string(),
});
export type ItemCandidate = z.infer<typeof ItemCandidate>;
export const MaterialRate = z.object({
  name: z.string().min(1),
  kind: Component.shape.kind,
  group: z.string(),
  unit: z.string().min(1),
  convert: z.number().positive(),
  baseUnit: Unit,
  price: Money.refine((v) => v.amount >= 0),
  basis: z.enum(['quote', 'catalog', 'invoice', 'estimate']),
  source: z.string().min(1),
  quotedAt: IsoDate,
  sheet: z
    .object({ l: z.number().positive(), w: z.number().positive(), t: z.number().positive() })
    .optional(),
});
export type MaterialRate = z.infer<typeof MaterialRate>;
export const Design = z.object({
  kind: z.enum(['photo', 'render', 'panorama', 'plan']),
  images: z.array(z.object({ url: z.url(), sha256: Hash, aiGenerated: z.boolean() })).min(1),
  hotspots: z
    .array(
      z.object({
        imageIndex: z.number().int().nonnegative(),
        productId: z.string(),
        spec: z.string(),
        at: z.union([z.object({ yaw: z.number(), pitch: z.number() }), Frame]),
      }),
    )
    .default([]),
});
export const Shape = z.enum(['table', 'cabinet', 'booth', 'curtain', 'rug', 'components']);
export const LineTemplate = z.object({
  shape: Shape,
  lineKind: LineItem.shape.lineKind,
  category: z.string(),
  budgetKey: BudgetKey,
  defaults: z.object({
    geometry: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    waste: z.number().nonnegative(),
    laborRate: Money,
    minLabor: Money,
    complexity: z.number().nonnegative(),
  }),
  components: z.array(Component),
});
export const BomCase = z.object({
  title: z.string(),
  designRefs: z.array(AssetRef),
  lines: z.array(BomLine).max(2000),
  referenceTotal: Money.optional(),
});
