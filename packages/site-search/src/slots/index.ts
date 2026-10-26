import { GeoPoint, IsoDateTime, Jurisdiction, Lang, Measure, type SlotDef, z } from '@osw/core';
export * from './listing.js';

export const PlaceObservation = z.object({
  provider: z.string().min(1),
  providerPlaceId: z.string().min(1),
  kind: z.enum(['direct', 'adjacent', 'substitute', 'candidate']),
  observedAt: IsoDateTime,
  curatedBy: z.string().min(1),
});
export const CompetitorQuery = z.object({
  queries: z.array(z.string().min(1)).min(1).max(2),
  lang: Lang,
  cuisine: z.string().optional(),
});
export const TradeArea = z
  .object({
    jurisdiction: Jurisdiction,
    center: GeoPoint.optional(),
    radiusKm: z.number().positive().max(100).optional(),
    tract: z.string().optional(),
    residents: Measure,
    method: z.enum(['published', 'exact', 'contained-blocks', 'apportioned']),
    period: z.string().min(1),
    residentsUpper: z.number().nonnegative().optional(),
  })
  .superRefine((area, ctx) => {
    if (!(area.center && area.radiusKm) && !area.tract)
      ctx.addIssue({ code: 'custom', message: 'A circle or tract is required' });
    if (typeof area.residents.value !== 'number' || area.residents.value < 0)
      ctx.addIssue({
        code: 'custom',
        path: ['residents'],
        message: 'Population must be numeric and nonnegative',
      });
    if (
      area.residentsUpper !== undefined &&
      typeof area.residents.value === 'number' &&
      area.residentsUpper < area.residents.value
    )
      ctx.addIssue({ code: 'custom', message: 'Upper bound must cover lower bound' });
  });
function define<S extends z.ZodObject>(
  name: string,
  schema: S,
  filterable: SlotDef<S>['filterable'],
): SlotDef<S> {
  return {
    name,
    slotVersion: '0.1.0',
    schema,
    filterable: { id: ['eq', 'in'], 'coverage.tracks': ['hasAny'], ...filterable },
    sortable: ['updatedAt'],
  };
}
export const placeObservationSlot = define('place-observation', PlaceObservation, {
  provider: ['eq'],
  providerPlaceId: ['eq', 'in'],
  kind: ['eq', 'in'],
});
export const competitorQuerySlot = define('competitor-query', CompetitorQuery, {
  cuisine: ['eq'],
  lang: ['eq'],
});
export const tradeAreaSlot = define('trade-area', TradeArea, {
  jurisdiction: ['eq', 'in', 'prefix'],
  center: ['within'],
  tract: ['eq'],
});
