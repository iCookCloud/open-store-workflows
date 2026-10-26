import {
  AssetRecord,
  type AssetRecordOf,
  AssetRef,
  type Filter,
  GeoPoint,
  Money,
  type Need,
  type StepCtx,
  StoreSpecBody,
  assetRef,
  convertUnit,
  z,
} from '@osw/core';
import {
  type Check,
  type Verdict,
  distanceKm,
  numberParam,
  queryAll,
  result,
  withExchangeRates,
} from '../rules/common.js';
import { checkRequirement, evidenceProblem } from '../rules/measure.js';
import { assessRent } from '../rules/rent.js';
import { Listing, type ListingData, listingSlot, tradeAreaSlot } from '../slots/index.js';

export const ScreeningInput = z.object({
  spec: StoreSpecBody,
  center: GeoPoint,
  additionalRent: z.record(z.string(), Money).optional(),
});
export const CheckSchema = z.object({
  key: z.string(),
  verdict: z.enum(['holds', 'fails', 'pending']),
  reason: z.string(),
  hard: z.boolean(),
});
export const ScreenedListing = z.object({
  listing: AssetRecord(Listing),
  sources: z.array(AssetRef),
  checks: z.array(CheckSchema),
  monthlyRent: Money.nullable(),
});
export const Screening = z.object({
  passed: z.array(ScreenedListing),
  pending: z.array(ScreenedListing),
  failed: z.array(ScreenedListing),
  capped: z.boolean(),
});
export type Screened = z.infer<typeof ScreenedListing>;
export function screeningFilter(input: z.infer<typeof ScreeningInput>, radiusKm: number): Filter {
  const { spec, center } = input;
  // 原始面积按单位分支，不能用平方米直接比较平方英尺；额外单位叶子在槽位显式声明。
  const overlap: Filter = {
    any: (['m2', 'ft2'] as const).map((unit) => ({
      all: [
        { field: 'area.unit', op: 'eq', value: unit },
        { field: 'area.min', op: 'lte', value: convertUnit(spec.area.maxM2, 'm2', unit).value! },
        { field: 'area.max', op: 'gte', value: convertUnit(spec.area.minM2, 'm2', unit).value! },
      ],
    })),
  };
  return {
    all: [
      { field: 'status', op: 'eq', value: 'active' },
      { field: 'jurisdiction', op: 'prefix', value: spec.jurisdiction },
      overlap,
      { field: 'geo', op: 'within', value: { ...center, radiusKm } },
      ...(!spec.concept.nonFood
        ? [{ not: { field: 'foodUse', op: 'eq', value: 'prohibited' } } as Filter]
        : []),
    ],
  };
}
export function compareCandidates(a: Screened, b: Screened): number {
  const n = (row: Screened, verdict: Verdict) =>
    row.checks.filter((c) => c.verdict === verdict && (verdict === 'fails' || c.hard)).length;
  const compare =
    n(a, 'fails') - n(b, 'fails') ||
    n(a, 'pending') - n(b, 'pending') ||
    Number(b.listing.data.deliveryCondition === 'second_gen_food') -
      Number(a.listing.data.deliveryCondition === 'second_gen_food') ||
    Number(b.listing.data.media.length > 0) - Number(a.listing.data.media.length > 0) ||
    (a.monthlyRent?.amount ?? Number.POSITIVE_INFINITY) -
      (b.monthlyRent?.amount ?? Number.POSITIVE_INFINITY);
  return compare || (a.listing.id < b.listing.id ? -1 : a.listing.id > b.listing.id ? 1 : 0);
}
export async function candidateChecks(
  listing: AssetRecordOf<ListingData>,
  input: z.infer<typeof ScreeningInput>,
  ctx: StepCtx,
  needs: Need[],
): Promise<Screened> {
  const { spec } = input;
  const data = listing.data;
  const stale = data.checkedAt > ctx.now || data.expiresAt < ctx.now.slice(0, 10);
  const check = (key: string, verdict: Verdict, reason: string): Check => ({
    key,
    verdict: stale ? 'pending' : verdict,
    reason: stale ? 'Listing evidence expired or is in the future' : reason,
    hard: true,
  });
  const areaMin = convertUnit(data.area.min, data.area.unit, 'm2').value!;
  const areaMax = convertUnit(data.area.max, data.area.unit, 'm2').value!;
  const checks: Check[] = [
    check(
      'status',
      data.status === 'active' ? 'holds' : 'fails',
      'Availability advertised by source',
    ),
    check(
      'foodUse',
      spec.concept.nonFood ? 'holds' : data.foodUse === 'prohibited' ? 'fails' : 'pending',
      'Advertised use requires independent confirmation',
    ),
    check(
      'area',
      areaMin <= spec.area.maxM2 && areaMax >= spec.area.minM2 ? 'holds' : 'fails',
      'Area ranges overlap',
    ),
    check(
      'deliveryCondition',
      data.deliveryCondition === 'unknown' ? 'pending' : 'holds',
      'Known delivery condition',
    ),
    ...spec.siteRequirements.map((r) =>
      checkRequirement(r, data.claims.find((c) => c.key === r.key)?.measure, ctx, needs),
    ),
  ];
  const rent = assessRent(data, spec, ctx, input.additionalRent?.[listing.id]);
  checks.push(...rent.checks);
  needs.push(...rent.needs);
  const minResidents = numberParam(
    ctx,
    'site.minResidents',
    needs,
    { jurisdiction: spec.jurisdiction, track: spec.concept.track },
    false,
  );
  const areas = await queryAll(
    ctx,
    tradeAreaSlot,
    { field: 'jurisdiction', op: 'prefix', value: spec.jurisdiction },
    200,
  );
  const relevant = areas
    .filter(
      (a) =>
        a.data.center &&
        a.data.radiusKm &&
        data.geo &&
        distanceKm(a.data.center, data.geo) <= a.data.radiusKm,
    )
    .sort((a, b) => a.data.radiusKm! - b.data.radiusKm! || (a.id < b.id ? -1 : 1));
  const trade = relevant[0]?.data;
  let population: Verdict = 'pending';
  if (
    trade &&
    minResidents !== undefined &&
    trade.method !== 'apportioned' &&
    !evidenceProblem(trade.residents, ctx, needs, true)
  ) {
    const lower = Number(trade.residents.value);
    population =
      lower >= minResidents
        ? 'holds'
        : trade.method === 'contained-blocks' &&
            (trade.residentsUpper === undefined || trade.residentsUpper >= minResidents)
          ? 'pending'
          : 'fails';
  }
  checks.push({
    key: 'residents',
    hard: true,
    verdict: population,
    reason: 'Population evidence must cover the candidate and meet the track threshold',
  });
  return {
    listing,
    checks,
    monthlyRent: rent.monthlyTotal,
    sources: [assetRef(listing), ...relevant.map((a) => assetRef(a))],
  };
}
export async function screenListings(raw: z.infer<typeof ScreeningInput>, ctx: StepCtx) {
  const input = ScreeningInput.parse(raw);
  const needs: Need[] = [];
  const radius = numberParam(ctx, 'site.searchRadiusKm', needs);
  const cap = numberParam(ctx, 'site.screenLimit', needs);
  if (radius !== undefined && (radius <= 0 || radius > 100))
    needs.push({
      kind: 'input',
      path: 'params.site.searchRadiusKm',
      reason: 'Radius must be in (0, 100]',
      blocking: true,
    });
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1))
    needs.push({
      kind: 'input',
      path: 'params.site.screenLimit',
      reason: 'Limit must be a positive integer',
      blocking: true,
    });
  if (needs.some((n) => n.blocking))
    return result<z.infer<typeof Screening>>(
      { passed: [], pending: [], failed: [], capped: false },
      needs,
    );
  const listings = await queryAll(ctx, listingSlot, screeningFilter(input, radius!), cap!);
  const rentContext = await withExchangeRates(
    ctx,
    listings.flatMap((l) =>
      l.data.askingRent
        ? [
            [l.data.askingRent.base.currency, input.spec.economics.spend.currency] as [
              string,
              string,
            ],
          ]
        : [],
    ),
  );
  const rows: Screened[] = [];
  for (const listing of listings)
    rows.push(await candidateChecks(listing, input, rentContext, needs));
  rows.sort(compareCandidates);
  const output: z.infer<typeof Screening> = {
    passed: [],
    pending: [],
    failed: [],
    capped: listings.length === cap,
  };
  for (const row of rows)
    output[
      row.checks.some((c) => c.verdict === 'fails')
        ? 'failed'
        : row.checks.some((c) => c.verdict === 'pending')
          ? 'pending'
          : 'passed'
    ].push(row);
  if (!rows.length)
    needs.push({
      kind: 'asset',
      slot: 'listing',
      filter: screeningFilter(input, radius!),
      reason: 'No matching listings',
      blocking: false,
    });
  return result(output, needs);
}
