import {
  Address,
  AssetRef,
  ConditionReading,
  GeoPoint,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
  SiteDecisionRent,
  type SlotDef,
  convertUnit,
  versionHash,
  z,
} from '@osw/core';

export const AskingRent = z
  .object({
    base: SiteDecisionRent.shape.base,
    period: SiteDecisionRent.shape.period,
    basis: SiteDecisionRent.shape.basis,
    areaUnit: SiteDecisionRent.shape.areaUnit,
  })
  .superRefine((rent, ctx) => {
    if (rent.base.amount < 0)
      ctx.addIssue({
        code: 'custom',
        path: ['base', 'amount'],
        message: 'Rent cannot be negative',
      });
    if (rent.basis === 'per_area' && !rent.areaUnit)
      ctx.addIssue({ code: 'custom', path: ['areaUnit'], message: 'Area unit is required' });
  });
export const ListingSource = z.object({
  kind: z.enum(['broker', 'feed', 'csv', 'manual']),
  name: z.string().min(1),
  url: z.url().nullable(),
  sourceListingId: z.string().nullable(),
  brokerParty: AssetRef.nullable(),
});
export const Listing = z.object({
  source: ListingSource,
  status: z.enum(['active', 'under_offer', 'leased', 'withdrawn']),
  address: Address,
  geo: GeoPoint.nullable(),
  jurisdiction: Jurisdiction,
  propertyType: z.enum(['retail', 'restaurant', 'mixed_use', 'food_hall', 'kiosk', 'other']),
  deliveryCondition: z.enum([
    'shell',
    'vanilla_box',
    'second_gen_food',
    'as_is',
    'turnkey',
    'unknown',
  ]),
  area: z
    .object({ min: z.number().positive(), max: z.number().positive(), unit: z.enum(['ft2', 'm2']) })
    .superRefine((a, ctx) => {
      if (a.min > a.max || (convertUnit(a.min, a.unit, 'ft2').value ?? 0) < 50)
        ctx.addIssue({ code: 'custom', message: 'Invalid or placeholder area' });
    }),
  askingRent: AskingRent.nullable(),
  additionalRent: z.enum(['nnn', 'modified_gross', 'gross', 'unknown']),
  foodUse: z.enum(['advertised', 'prohibited', 'unknown']),
  restrictions: z.array(z.string()),
  claims: z.array(ConditionReading),
  media: z.array(
    z.object({
      ref: z.string(),
      role: z.enum(['hero', 'plan', 'photo']),
      license: z.enum(['own', 'licensed', 'source_only']),
    }),
  ),
  checkedAt: IsoDateTime,
  expiresAt: IsoDate,
  refs: z.array(z.string()).min(1),
});
export type ListingData = z.infer<typeof Listing>;
export const listingSlot: SlotDef<typeof Listing> = {
  name: 'listing',
  slotVersion: '0.1.0',
  schema: Listing,
  filterable: {
    id: ['eq', 'in'],
    status: ['eq', 'in'],
    foodUse: ['eq', 'in'],
    propertyType: ['eq', 'in'],
    deliveryCondition: ['eq', 'in'],
    jurisdiction: ['eq', 'in', 'prefix'],
    'source.kind': ['eq', 'in'],
    'area.unit': ['eq'],
    'area.min': ['gte', 'lte'],
    'area.max': ['gte', 'lte'],
    checkedAt: ['gte', 'lte'],
    geo: ['within'],
    'coverage.tracks': ['hasAny'],
  },
  sortable: ['updatedAt', 'checkedAt'],
};

// 使用完整源身份生成稳定 ID，重排和刷新内容不改变引用；冲突信息必须是稳定的源键。
export async function deriveListingId(
  source: z.infer<typeof ListingSource>,
  collisionKey?: string,
): Promise<string> {
  const parsed = ListingSource.parse(source);
  if (!parsed.sourceListingId && !parsed.url)
    throw new Error('A stable sourceListingId or URL is required');
  const identity = [parsed.kind, parsed.name, parsed.sourceListingId || parsed.url];
  return `${parsed.kind}-${(await versionHash(identity)).slice(0, 32)}${collisionKey ? `-${(await versionHash(collisionKey)).slice(0, 12)}` : ''}`;
}
