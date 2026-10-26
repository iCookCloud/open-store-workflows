export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export function normalize(v: unknown): Json {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length ? v.map(normalize) : null;
  if (typeof v !== 'object') return String(v);
  const out: Record<string, Json> = Object.create(null);
  for (const k of Object.keys(v).sort()) {
    const n = normalize((v as Record<string, unknown>)[k]);
    if (n !== null) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}
export function canonicalJson(v: unknown): string {
  return JSON.stringify(normalize(v));
}
export async function versionHash(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(v));
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function fieldsetHash(
  data: Record<string, unknown>,
  keys: readonly string[],
): Promise<string> {
  return versionHash(Object.fromEntries(keys.map((k) => [k, data[k]])));
}
