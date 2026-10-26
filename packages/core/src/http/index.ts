import { z } from '../base.js';
import { OswSourceError } from '../errors.js';
import type { Filter, Scalar } from '../filter.js';
import { validateFilter } from '../filter.js';
import type { AssetRecordOf, SlotDef } from '../slot.js';
import { parseRecord } from '../slot.js';
import type { AssetSource, CountOpts, Page, QueryOpts } from '../source.js';
import { validateQuery } from '../source.js';
import type { Fill, RecordResult, Verification } from '../verification.js';
import { OSW_VERSION, ResultsResponse, SlotsResponse } from './protocol.js';
export * from './protocol.js';
export interface HttpSourceOptions {
  token?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}
export class HttpSource implements AssetSource {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly options: HttpSourceOptions;
  constructor(baseUrl: string, options: HttpSourceOptions = {}) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid asset source URL');
    this.base = baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.options = options;
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const max = Math.min(3, Math.max(0, this.options.maxRetries ?? 3));
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Osw-Client': `@osw/core@${OSW_VERSION}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
        });
      } catch (error) {
        throw new OswSourceError(
          'source_unavailable',
          error instanceof Error ? error.message : 'Network error',
        );
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new OswSourceError('source_unavailable', 'Invalid JSON response', {
          status: response.status,
        });
      }
      if (response.ok) return data;
      const err = (data as { error?: { code?: string; message?: string; detail?: unknown } })
        ?.error;
      const retryHeader = response.headers.get('Retry-After');
      const retry = retryHeader?.trim() ? Number(retryHeader) : Number.NaN;
      if ([429, 503].includes(response.status) && attempt < max) {
        const ms =
          Number.isFinite(retry) && retry >= 0
            ? Math.min(retry * 1000, 60000)
            : Math.min(1000 * 2 ** attempt, 10000);
        await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          ms,
        );
        continue;
      }
      throw new OswSourceError(
        err?.code ?? 'source_unavailable',
        err?.message ?? `HTTP ${response.status}`,
        {
          status: response.status,
          ...(Number.isFinite(retry) ? { retryAfterS: retry } : {}),
          detail: err?.detail,
        },
      );
    }
  }
  async listSlots() {
    return SlotsResponse.parse(await this.request('/slots')).slots;
  }
  async query<S extends z.ZodObject>(
    slot: SlotDef<S>,
    filter: Filter | null,
    opts: QueryOpts = {},
  ): Promise<Page<z.infer<S>>> {
    validateQuery(slot, filter, opts);
    const raw = z
      .object({ items: z.array(z.unknown()), nextCursor: z.string().max(2048).nullable() })
      .parse(
        await this.request(`/slots/${encodeURIComponent(slot.name)}/query`, { filter, ...opts }),
      );
    if (raw.items.length > (opts.limit ?? 50))
      throw new OswSourceError('source_unavailable', 'Source exceeded page limit');
    return { items: raw.items.map((r) => parseRecord(slot, r)), nextCursor: raw.nextCursor };
  }
  async get<S extends z.ZodObject>(
    slot: SlotDef<S>,
    id: string,
  ): Promise<AssetRecordOf<z.infer<S>> | null> {
    try {
      return parseRecord(
        slot,
        await this.request(
          `/slots/${encodeURIComponent(slot.name)}/items/${encodeURIComponent(id)}`,
        ),
      );
    } catch (e) {
      if (e instanceof OswSourceError && e.status === 404 && e.code === 'not_found') return null;
      throw e;
    }
  }
  async count(
    slot: SlotDef,
    filter: Filter | null,
    opts: CountOpts,
  ): Promise<{ key: Scalar[]; n: number }[]> {
    validateFilter(slot, filter);
    if (opts.groupBy.length < 1 || opts.groupBy.length > 2)
      throw new OswSourceError('invalid_filter', 'Invalid group count');
    return z
      .object({
        groups: z
          .array(
            z.object({
              key: z.array(z.union([z.string(), z.number(), z.boolean()])),
              n: z.number().int().nonnegative(),
            }),
          )
          .max(1000),
      })
      .parse(
        await this.request(`/slots/${encodeURIComponent(slot.name)}/count`, { filter, ...opts }),
      ).groups;
  }
  async recordVerification(items: readonly Verification[]): Promise<RecordResult[]> {
    return this.write('/verifications', items);
  }
  async applyFills(items: readonly Fill[]): Promise<RecordResult[]> {
    return this.write('/fills', items);
  }
  private async write(path: string, items: readonly unknown[]): Promise<RecordResult[]> {
    if (items.length > 200)
      throw new OswSourceError('too_many', 'At most 200 items', { status: 413 });
    const out = ResultsResponse.parse(await this.request(path, { items })).results;
    if (out.length !== items.length)
      throw new OswSourceError('source_unavailable', 'Mismatched record result count');
    return out;
  }
}
