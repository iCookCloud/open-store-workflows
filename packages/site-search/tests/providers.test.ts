import { MemorySource, validateFilter } from '@osw/core';
import { HttpSource } from '@osw/core/http';
import { describe, expect, it, vi } from 'vitest';
import { csvListingFeed, parseCsv } from '../src/providers/csv-listing-feed.js';
import { googlePlaces } from '../src/providers/google-places.js';
import { nominatim } from '../src/providers/nominatim.js';
import { MemoryCacheStore, MemoryQuotaStore } from '../src/providers/types.js';
import { listingSlot, tradeAreaSlot } from '../src/slots/index.js';
import { deduplicatePlaces, scanSurroundings } from '../src/steps/scan.js';
import { screenListings } from '../src/steps/screen.js';
import { context, defaults, listingData, record, spec } from './fixtures.js';

describe('provider limits and persisted output', () => {
  it('allows exactly five of twenty concurrent quota attempts and expires atomically', async () => {
    let now = 0;
    const quota = new MemoryQuotaStore(() => now);
    const out = await Promise.all(
      Array.from({ length: 20 }, () => quota.consume('places', 'day', 5, 86400)),
    );
    expect(out.filter(Boolean)).toHaveLength(5);
    now = 86400000;
    expect(await quota.consume('places', 'day', 5, 86400)).toBe(true);
  });
  it('deduplicates namespaced IDs/addresses and clips from the candidate location', () => {
    const hits = [
      { providerPlaceId: 'a', geo: { lat: 0, lng: 0 }, address: '100 Example ROAD' },
      { providerPlaceId: 'b', geo: { lat: 0, lng: 0 }, address: '100 example road' },
      { providerPlaceId: 'c', geo: { lat: 1, lng: 0 } },
      { providerPlaceId: 'd', geo: { lat: 0, lng: 0 }, businessStatus: 'CLOSED_PERMANENTLY' },
    ];
    expect(deduplicatePlaces(hits, { lat: 0, lng: 0 }, 2).map((h) => h.providerPlaceId)).toEqual([
      'a',
    ]);
  });
  it('keeps only durable identifiers and curated classification in scan output', async () => {
    const listing = await record('listing', 'one', listingData());
    const query = await record('competitor-query', 'queries', {
      queries: ['example noodles'],
      lang: 'en',
    });
    query.coverage.tracks = [spec.concept.track];
    const search = vi.fn(async () => [
      {
        providerPlaceId: 'a',
        geo: { lat: 0, lng: 0 },
        name: 'Transient name',
        address: 'Transient address',
      },
    ]);
    const ctx = context([listing, query], {
      providers: {
        places: { name: 'example', persistable: ['providerPlaceId'], maxCacheSeconds: 0, search },
        listingFeed: csvListingFeed('id\none', () => listingData()),
      },
    });
    const out = await scanSurroundings(
      { decisionId: 'example-decision', candidates: [listing], track: spec.concept.track },
      ctx,
    );
    expect(out.output?.candidates[0]?.competitors).toEqual([
      { provider: 'example', providerPlaceId: 'a', kind: 'candidate' },
    ]);
    expect(JSON.stringify(out.output)).not.toContain('Transient');
    expect(out.needs).toContainEqual(expect.objectContaining({ action: 'ingestListing' }));
  });
  it('applies listing item and charge caps across all candidates', async () => {
    const listing = await record('listing', 'one', listingData());
    const second = await record('listing', 'two', listingData({ geo: { lat: 0.001, lng: 0 } }));
    const query = await record('competitor-query', 'queries', { queries: ['example'], lang: 'en' });
    query.coverage.tracks = [spec.concept.track];
    const search = vi.fn(async () => [listingData(), listingData()]);
    const ctx = context([listing, second, query], {
      params: { ...defaults, 'listingFeed.maxItemsPerRun': 1, 'listingFeed.maxChargePerRun': 10 },
      providers: {
        places: {
          name: 'example',
          persistable: ['providerPlaceId'],
          maxCacheSeconds: 0,
          search: async () => [],
        },
        listingFeed: { name: 'example', search },
      },
    });
    const out = await scanSurroundings(
      { decisionId: 'cap-test', candidates: [listing, second], track: spec.concept.track },
      ctx,
    );
    expect(out.output?.candidates.flatMap((c) => c.vacancies)).toHaveLength(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({ limit: 1, maxCharge: 5 });
  });
  it('returns blocking provider need on quota exhaustion', async () => {
    const listing = await record('listing', 'one', listingData());
    const query = await record('competitor-query', 'queries', { queries: ['example'], lang: 'en' });
    query.coverage.tracks = [spec.concept.track];
    const search = vi.fn(async () => []);
    const ctx = context([listing, query], {
      providers: {
        places: { name: 'example', persistable: ['providerPlaceId'], maxCacheSeconds: 0, search },
        listingFeed: csvListingFeed('id\none', () => listingData()),
      },
    });
    await ctx.stores!.quota.consume('places', ctx.now.slice(0, 10), 1, 86400);
    ctx.params = { get: (key) => ({ value: key === 'places.dailyCap' ? 1 : defaults[key]! }) };
    const out = await scanSurroundings(
      { decisionId: 'one', candidates: [listing], track: spec.concept.track },
      ctx,
    );
    expect(out.output).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(out.needs.some((n) => n.kind === 'provider')).toBe(true);
  });
  it('Google adapter refuses mismatched Place IDs and does not persist content', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ id: 'other', location: { latitude: 0, longitude: 0 } }),
    );
    const provider = googlePlaces({ apiKey: 'example-token', fetch: fetcher });
    expect(provider.maxCacheSeconds).toBe(0);
    await expect(provider.details('requested')).rejects.toThrow('identity');
    expect(fetcher.mock.calls[0]?.[0]).toContain('requested');
  });
  it('Nominatim identifies the application, caches successes, and limits requests', async () => {
    const cache = new MemoryCacheStore(() => 0);
    const quota = new MemoryQuotaStore(() => 0);
    const fetcher = vi.fn(async () => Response.json([{ lat: '1', lon: '2' }]));
    const provider = nominatim({
      userAgent: 'Example (example.com)',
      cache,
      quota,
      cacheSeconds: 10,
      fetch: fetcher,
    });
    expect(await provider.geocode('Example Road')).toEqual({ lat: 1, lng: 2 });
    await provider.geocode('Example Road');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(provider.geocode('Other road')).rejects.toThrow('quota');
  });
  it('parses quoted CSV commas, escaped quotes, and embedded newlines', () => {
    expect(parseCsv('id,note\n1,"a,b"\n2,"a""b\nc"')).toEqual([
      { id: '1', note: 'a,b' },
      { id: '2', note: 'a"b\nc' },
    ]);
    expect(() => parseCsv('id,note\n1,"open')).toThrow('Unterminated');
  });
  it('sends real filtering and limits through HttpSource with the same results as MemorySource', async () => {
    const listing = await record('listing', 'one', listingData());
    const memory = new MemorySource([listing]);
    const bodies: unknown[] = [];
    const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const slot = String(url).includes('/listing/') ? listingSlot : tradeAreaSlot;
      validateFilter(slot, body.filter);
      const page = await memory.query(slot, body.filter, {
        limit: body.limit,
        cursor: body.cursor,
      });
      return Response.json(page);
    };
    const http = new HttpSource('https://example.com/osw/v1', { fetch: fetcher });
    const input = { spec, center: { lat: 0, lng: 0 } };
    const ctx = context([listing]);
    const direct = await screenListings(input, ctx);
    const remote = await screenListings(input, { ...ctx, assets: http });
    expect(remote).toEqual(direct);
    expect(bodies[0]).toMatchObject({ filter: expect.any(Object), limit: 200 });
  });
});
