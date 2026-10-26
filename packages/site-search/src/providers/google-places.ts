import { PlaceHit, type PlacesProvider } from './types.js';
export function googlePlaces(options: { apiKey: string; fetch?: typeof fetch }): PlacesProvider & {
  details(id: string): Promise<PlaceHit>;
} {
  const request = options.fetch ?? globalThis.fetch;
  const normalize = (raw: Record<string, unknown>): PlaceHit => {
    const location = raw.location as { latitude: number; longitude: number };
    return PlaceHit.parse({
      providerPlaceId: raw.id,
      geo: { lat: location?.latitude, lng: location?.longitude },
      address: raw.formattedAddress,
      name: (raw.displayName as { text?: string })?.text,
      businessStatus: raw.businessStatus,
    });
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': options.apiKey,
    'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress,places.businessStatus',
  };
  return {
    name: 'google-places',
    persistable: ['providerPlaceId'],
    maxCacheSeconds: 0,
    async search(input) {
      const response = await request('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          textQuery: input.text,
          pageSize: Math.min(20, input.limit),
          locationBias: {
            circle: {
              center: { latitude: input.center.lat, longitude: input.center.lng },
              radius: input.radiusKm * 1000,
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`Places search failed: ${response.status}`);
      const payload = (await response.json()) as { places?: Record<string, unknown>[] };
      return (payload.places ?? []).map(normalize);
    },
    async details(id) {
      const response = await request(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`,
        {
          headers: {
            ...headers,
            'X-Goog-FieldMask': 'id,location,formattedAddress,businessStatus',
          },
        },
      );
      if (!response.ok) throw new Error(`Places details failed: ${response.status}`);
      const hit = normalize((await response.json()) as Record<string, unknown>);
      if (hit.providerPlaceId !== id) throw new Error('Place identity mismatch');
      return hit;
    },
  };
}
