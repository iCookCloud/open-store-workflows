import { type CacheStore, GeoPoint, type QuotaStore, versionHash } from '@osw/core';
import type { GeocodeProvider } from './types.js';
export function nominatim(options: {
  userAgent: string;
  quota: QuotaStore;
  cache: CacheStore;
  cacheSeconds: number;
  fetch?: typeof fetch;
}): GeocodeProvider {
  if (!options.userAgent.trim() || options.cacheSeconds <= 0)
    throw new Error('Identifying User-Agent and cache lifetime are required');
  const request = options.fetch ?? globalThis.fetch;
  return {
    async geocode(address) {
      const key = `nominatim:${await versionHash(address)}`;
      const cached = await options.cache.get(key);
      if (cached) return GeoPoint.parse(cached);
      if (!(await options.quota.consume('nominatim', 'global', 1, 1)))
        throw new Error('Nominatim quota exceeded');
      const response = await request(
        `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: address, format: 'jsonv2', limit: '1' })}`,
        { headers: { 'User-Agent': options.userAgent } },
      );
      if (!response.ok) throw new Error(`Geocoding failed: ${response.status}`);
      const rows = (await response.json()) as { lat: string; lon: string }[];
      if (!rows.length) return null;
      const point = GeoPoint.parse({ lat: Number(rows[0]!.lat), lng: Number(rows[0]!.lon) });
      await options.cache.put(key, point, options.cacheSeconds);
      return point;
    },
  };
}
