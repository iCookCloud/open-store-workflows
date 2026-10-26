import {
  type AssetRef,
  type CacheStore,
  GeoPoint,
  type QuotaStore,
  type StepCtx,
  z,
} from '@osw/core';
import type { Listing } from '../slots/listing.js';
export const PlaceHit = z.object({
  providerPlaceId: z.string().min(1),
  geo: GeoPoint,
  address: z.string().optional(),
  name: z.string().optional(),
  businessStatus: z.string().optional(),
});
export type PlaceHit = z.infer<typeof PlaceHit>;
export interface PlacesProvider {
  name: string;
  persistable: readonly string[];
  maxCacheSeconds: number;
  search(input: {
    center: z.infer<typeof GeoPoint>;
    radiusKm: number;
    text: string;
    limit: number;
  }): Promise<PlaceHit[]>;
}
export interface ListingFeed {
  name: string;
  search(input: {
    center: z.infer<typeof GeoPoint>;
    radiusKm: number;
    jurisdiction: string;
    limit: number;
    maxCharge: number;
  }): Promise<z.infer<typeof Listing>[]>;
}
export interface EsignProvider {
  collect(input: { contentHash: string; signers: AssetRef[] }): Promise<{
    contentHash: string;
    signedAt: string;
    envelopeRef: string;
    signedPdf: Uint8Array;
    signedPdfHash: string;
    auditCertificate: Uint8Array;
    auditHash: string;
  } | null>;
}
export interface GeocodeProvider {
  geocode(address: string): Promise<z.infer<typeof GeoPoint> | null>;
}
export interface SiteSearchProviders {
  places: PlacesProvider;
  listingFeed: ListingFeed;
  esign: EsignProvider;
  geocode: GeocodeProvider;
}
declare module '@osw/core' {
  interface OswProviders extends SiteSearchProviders {}
}
export function siteProviders(ctx: StepCtx): Partial<SiteSearchProviders> {
  return ctx.providers;
}
// 单进程测试/本地宿主适配；分布式宿主必须注入自己的原子存储。
export class MemoryQuotaStore implements QuotaStore {
  private readonly buckets = new Map<string, { expires: number; count: number }>();
  constructor(private readonly clock: () => number) {}
  async consume(scope: string, key: string, limit: number, windowSec: number): Promise<boolean> {
    if (!Number.isInteger(limit) || limit < 0 || !Number.isFinite(windowSec) || windowSec <= 0)
      throw new Error('Invalid quota policy');
    const now = this.clock();
    const id = JSON.stringify([scope, key]);
    let bucket = this.buckets.get(id);
    if (!bucket || bucket.expires <= now) {
      bucket = { expires: now + windowSec * 1000, count: 0 };
      this.buckets.set(id, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count++;
    return true;
  }
}
export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { expires: number; value: unknown }>();
  constructor(private readonly clock: () => number) {}
  async get(key: string): Promise<unknown> {
    const entry = this.entries.get(key);
    return entry && entry.expires > this.clock() ? structuredClone(entry.value) : undefined;
  }
  async put(key: string, value: unknown, ttlSec: number): Promise<void> {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) return;
    this.entries.set(key, { expires: this.clock() + ttlSec * 1000, value: structuredClone(value) });
  }
}
export async function bytesHash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
