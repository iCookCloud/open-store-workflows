import {
  AssetRecord,
  type Need,
  type StepCtx,
  jurisdictionPrefixes,
  versionHash,
  z,
} from '@osw/core';
import { PlaceHit, siteProviders } from '../providers/types.js';
import { distanceKm, inputNeed, numberParam, queryAll, result } from '../rules/common.js';
import { Listing, competitorQuerySlot, listingSlot, placeObservationSlot } from '../slots/index.js';
export const ScanInput = z.object({
  decisionId: z.string().min(1),
  candidates: z.array(AssetRecord(Listing)).min(1),
  track: z.string(),
  cuisine: z.string().optional(),
});
export const Surroundings = z.object({
  candidates: z.array(
    z.object({
      listingId: z.string(),
      competitors: z.array(
        z.object({
          provider: z.string(),
          providerPlaceId: z.string(),
          kind: z.enum(['direct', 'adjacent', 'substitute', 'candidate']),
        }),
      ),
      vacancies: z.array(Listing),
    }),
  ),
});
function cell(point: { lat: number; lng: number }) {
  const lat = [-90, 90];
  const lng = [-180, 180];
  let bits = '';
  let hash = '';
  const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';
  for (let i = 0; i < 30; i++) {
    const range = i % 2 === 0 ? lng : lat;
    const mid = (range[0]! + range[1]!) / 2;
    const high = (i % 2 === 0 ? point.lng : point.lat) >= mid;
    bits += high ? '1' : '0';
    range[high ? 0 : 1] = mid;
    if (bits.length === 5) {
      hash += alphabet[Number.parseInt(bits, 2)];
      bits = '';
    }
  }
  const center = { lat: (lat[0]! + lat[1]!) / 2, lng: (lng[0]! + lng[1]!) / 2 };
  return { hash, center, pad: distanceKm(center, { lat: lat[1]!, lng: lng[1]! }) };
}
export function deduplicatePlaces(
  hits: z.infer<typeof PlaceHit>[],
  center: { lat: number; lng: number },
  radiusKm: number,
): z.infer<typeof PlaceHit>[] {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  return hits
    .filter(
      (h) => h.businessStatus !== 'CLOSED_PERMANENTLY' && distanceKm(center, h.geo) <= radiusKm,
    )
    .sort((a, b) => (a.providerPlaceId < b.providerPlaceId ? -1 : 1))
    .filter((h) => {
      const address = h.address
        ?.normalize('NFKC')
        .toLowerCase()
        .replace(/[\s\p{P}]+/gu, '');
      if (ids.has(h.providerPlaceId) || (address && addresses.has(address))) return false;
      ids.add(h.providerPlaceId);
      if (address) addresses.add(address);
      return true;
    });
}
export async function scanSurroundings(raw: z.infer<typeof ScanInput>, ctx: StepCtx) {
  const input = ScanInput.parse(raw);
  const needs: Need[] = [];
  const radius = numberParam(ctx, 'site.competitorRadiusKm', needs);
  const maxScans = numberParam(ctx, 'site.maxScansPerDecision', needs);
  const daily = numberParam(ctx, 'places.dailyCap', needs);
  const reuseDays = numberParam(ctx, 'places.reuseDays', needs);
  const feedHours = numberParam(ctx, 'listingFeed.reuseHours', needs);
  const feedLimit = numberParam(ctx, 'listingFeed.maxItemsPerRun', needs);
  const maxCharge = numberParam(ctx, 'listingFeed.maxChargePerRun', needs);
  if (!siteProviders(ctx).places || !siteProviders(ctx).listingFeed || !ctx.stores)
    needs.push({
      kind: 'provider',
      name: !siteProviders(ctx).places
        ? 'places'
        : !siteProviders(ctx).listingFeed
          ? 'listingFeed'
          : 'stores',
      reason: 'Provider and atomic quota/cache stores are required',
      blocking: true,
    });
  if (radius !== undefined && (radius <= 0 || radius > 49))
    needs.push(
      inputNeed(
        'params.site.competitorRadiusKm',
        'Radius must be in (0,49] to allow the shared cell border',
      ),
    );
  for (const [key, value] of [
    ['site.maxScansPerDecision', maxScans],
    ['places.dailyCap', daily],
    ['listingFeed.maxItemsPerRun', feedLimit],
  ] as const)
    if (value !== undefined && (!Number.isInteger(value) || value < 1))
      needs.push(inputNeed(`params.${key}`, 'A positive integer is required'));
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const queryAssets = await queryAll(
    ctx,
    competitorQuerySlot,
    { field: 'coverage.tracks', op: 'hasAny', value: [input.track] },
    200,
  );
  const queries = [
    ...new Set(
      queryAssets
        .filter((q) => !q.data.cuisine || q.data.cuisine === input.cuisine)
        .flatMap((q) => q.data.queries),
    ),
  ];
  if (!queries.length)
    return result(null, [
      {
        kind: 'asset',
        slot: 'competitor-query',
        filter: null,
        reason: 'No matching competitor queries',
        blocking: true,
      },
    ]);
  const output: z.infer<typeof Surroundings> = { candidates: [] };
  const provider = siteProviders(ctx).places!;
  const feed = siteProviders(ctx).listingFeed!;
  const stores = ctx.stores!;
  for (const listing of input.candidates) {
    const center = listing.data.geo;
    if (!center) {
      needs.push(inputNeed(`candidates.${listing.id}.geo`, 'Candidate coordinates required'));
      continue;
    }
    const grid = cell(center);
    const hits: z.infer<typeof PlaceHit>[] = [];
    try {
      for (const text of queries) {
        const key = `places:${await versionHash({ provider: provider.name, text, cell: grid.hash, radius })}`;
        const cached = provider.maxCacheSeconds > 0 ? await stores.cache.get(key) : undefined;
        if (cached) {
          hits.push(...z.array(PlaceHit).parse(cached));
          continue;
        }
        if (
          !(await stores.quota.consume('site-search', input.decisionId, maxScans!, 86400)) ||
          !(await stores.quota.consume('places', ctx.now.slice(0, 10), daily!, 86400))
        ) {
          needs.push({
            kind: 'provider',
            name: 'places',
            reason: 'Scan quota exhausted',
            blocking: true,
          });
          break;
        }
        const fresh = z.array(PlaceHit).parse(
          await provider.search({
            center: grid.center,
            radiusKm: radius! + grid.pad,
            text,
            limit: 20,
          }),
        );
        hits.push(...fresh);
        const ttl = Math.min(provider.maxCacheSeconds, reuseDays! * 86400);
        if (ttl > 0) await stores.cache.put(key, fresh, ttl);
      }
      const feedKey = `listing-feed:${await versionHash({ provider: feed.name, center, radius, jurisdiction: listing.data.jurisdiction, limit: feedLimit, maxCharge })}`;
      let vacancies = await stores.cache.get(feedKey);
      if (!vacancies) {
        vacancies = await feed.search({
          center,
          radiusKm: radius!,
          jurisdiction: listing.data.jurisdiction,
          limit: feedLimit!,
          maxCharge: maxCharge!,
        });
        if (feedHours! > 0) await stores.cache.put(feedKey, vacancies, feedHours! * 3600);
      }
      const drafts = z
        .array(Listing)
        .parse(vacancies)
        .filter((v) => v.geo && distanceKm(v.geo, center) <= radius!)
        .slice(0, feedLimit);
      for (const draft of drafts)
        needs.push({
          kind: 'action',
          action: 'ingestListing',
          ref: draft.source.sourceListingId ?? draft.source.url ?? undefined,
          reason: 'Review and ingest listing draft in the asset source',
          blocking: false,
        });
      const unique = deduplicatePlaces(hits, center, radius!);
      const observations = unique.length
        ? await queryAll(
            ctx,
            placeObservationSlot,
            {
              all: [
                { field: 'provider', op: 'eq', value: provider.name },
                {
                  field: 'providerPlaceId',
                  op: 'in',
                  value: unique.slice(0, 200).map((h) => h.providerPlaceId),
                },
              ],
            },
            200,
          )
        : [];
      output.candidates.push({
        listingId: listing.id,
        competitors: unique.map((h) => ({
          provider: provider.name,
          providerPlaceId: h.providerPlaceId,
          kind:
            observations.find((o) => o.data.providerPlaceId === h.providerPlaceId)?.data.kind ??
            'candidate',
        })),
        vacancies: drafts,
      });
    } catch {
      needs.push({
        kind: 'provider',
        name: 'surroundings',
        reason: 'Provider failed or returned invalid data',
        blocking: true,
      });
    }
  }
  return result(output, needs);
}
