import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConformanceSlot, conformanceRecords, runConformance } from '../src/conformance/index.js';
import { HttpSource } from '../src/http/index.js';
import {
  type AnyAssetRecord,
  type AssetSource,
  MemorySource,
  OswSourceError,
  ProductSlot,
  defineSlot,
  fieldsetHash,
  parseRecord,
  versionHash,
  z,
} from '../src/index.js';
import { FileSource, recordsFromCsv } from '../src/node/file-source.js';
describe('review: source contract defects', () => {
  it('applies distinct fills from one observed version as one batch, then rejects stale callers', async () => {
    const records = await conformanceRecords();
    const source = new MemorySource(records, [ConformanceSlot]);
    const base = {
      asset: { slot: 'conformance', id: '4', versionHash: records[3].versionHash },
      by: 'example:tester',
      at: '2026-01-01T00:00:00Z',
    };
    expect(
      await source.applyFills([
        { ...base, field: 'note', value: 'verified' },
        { ...base, field: 'score', value: 25 },
        { ...base, field: 'note', value: 'overwrite' },
      ]),
    ).toEqual([{ status: 'recorded' }, { status: 'recorded' }, { status: 'not_empty' }]);
    expect((await source.get(ConformanceSlot, '4'))?.data).toMatchObject({
      note: 'verified',
      score: 25,
    });
    expect(await source.applyFills([{ ...base, field: 'jurisdiction', value: 'XE' }])).toEqual([
      { status: 'source_changed' },
    ]);
  });
  it('reopens a multi-field journal batch and accepts an already materialized value', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osw-batch-replay-'));
    const records = await conformanceRecords();
    const file = join(directory, 'conformance.json');
    await writeFile(file, JSON.stringify(records));
    const source = await FileSource.open(directory, [ConformanceSlot]);
    const common = {
      asset: { slot: 'conformance', id: '4', versionHash: records[3].versionHash },
      by: 'example:tester',
      at: '2026-01-01T00:00:00Z',
    };
    expect(
      await source.applyFills([
        { ...common, field: 'note', value: 'verified' },
        { ...common, field: 'score', value: 25 },
      ]),
    ).toEqual([{ status: 'recorded' }, { status: 'recorded' }]);
    const reopened = await FileSource.open(directory, [ConformanceSlot]);
    expect((await reopened.get(ConformanceSlot, '4'))?.data).toMatchObject({
      note: 'verified',
      score: 25,
    });
    records[3] = (await reopened.get(ConformanceSlot, '4'))!;
    await writeFile(file, JSON.stringify(records));
    expect(
      (await (await FileSource.open(directory, [ConformanceSlot])).get(ConformanceSlot, '4'))?.data
        .note,
    ).toBe('verified');
  });
  it('reports journal replay conflicts instead of silently dropping prior fills', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osw-replay-review-'));
    const records = await conformanceRecords();
    const file = join(directory, 'conformance.json');
    await writeFile(file, JSON.stringify(records));
    const source = await FileSource.open(directory, [ConformanceSlot]);
    await source.applyFills([
      {
        asset: { slot: 'conformance', id: '1', versionHash: records[0].versionHash },
        field: 'note',
        value: 'verified',
        by: 'example:tester',
        at: '2026-01-01T00:00:00Z',
      },
    ]);
    records[0].data.label = 'Changed externally';
    records[0].versionHash = await versionHash(records[0].data);
    await writeFile(file, JSON.stringify(records));
    await expect(FileSource.open(directory, [ConformanceSlot])).rejects.toMatchObject({
      code: 'journal_conflict',
    });
    expect(JSON.parse(await readFile(file, 'utf8'))[0].data.label).toBe('Changed externally');
  });
  it('searches all product translations and paginates deterministic name sorting', async () => {
    const records = await Promise.all(
      [{ en: 'Zed Chair', zh: '示例椅' }, { en: 'Amy Chair' }, { zh: '示例桌' }].map(
        async (name, index) => {
          const data = {
            name,
            kind: 'catalog',
            category: 'example',
            goodsClass: 'nonfood',
            status: 'active',
          };
          return {
            slot: 'product',
            id: `example-${index}`,
            slotVersion: ProductSlot.slotVersion,
            coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
            updatedAt: '2026-01-01T00:00:00Z',
            data,
            versionHash: await versionHash(data),
            fieldsetHashes: Object.fromEntries(
              await Promise.all(
                Object.entries(ProductSlot.fieldsets!).map(async ([key, fields]) => [
                  key,
                  await fieldsetHash(data, fields),
                ]),
              ),
            ),
          };
        },
      ),
    );
    const source = new MemorySource(records as AnyAssetRecord[], [ProductSlot]);
    expect(
      (await source.query(ProductSlot, { field: 'name', op: 'contains', value: 'chair' })).items,
    ).toHaveLength(2);
    expect(
      (
        await source.query(ProductSlot, { field: 'name', op: 'contains', value: '示例桌' })
      ).items.map((r) => r.id),
    ).toEqual(['example-2']);
    const first = await source.query(ProductSlot, null, {
      limit: 1,
      sort: [{ field: 'name', dir: 'asc' }],
    });
    expect(first.items[0].id).toBe('example-1');
    const second = await source.query(ProductSlot, null, {
      limit: 1,
      sort: [{ field: 'name', dir: 'asc' }],
      cursor: first.nextCursor,
    });
    expect(second.items[0].id).toBe('example-0');
  });
});
function referenceFetch(source: AssetSource): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const parts = url.pathname.split('/').filter(Boolean);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    try {
      let out: unknown;
      if (parts.at(-1) === 'query') out = await source.query(ConformanceSlot, body.filter, body);
      else if (parts.at(-1) === 'count')
        out = { groups: await source.count?.(ConformanceSlot, body.filter, body) };
      else if (parts.includes('items')) {
        out = await source.get(ConformanceSlot, decodeURIComponent(parts.at(-1)!));
        if (!out)
          return Response.json(
            { error: { code: 'not_found', message: 'missing' } },
            { status: 404 },
          );
      } else if (parts.at(-1) === 'verifications')
        out = { results: await source.recordVerification(body.items) };
      else if (parts.at(-1) === 'fills') out = { results: await source.applyFills?.(body.items) };
      else out = { slots: [] };
      return Response.json(out);
    } catch (e) {
      if (e instanceof OswSourceError)
        return Response.json(
          { error: { code: e.code, message: e.message } },
          { status: e.status ?? 400 },
        );
      throw e;
    }
  }) as typeof fetch;
}
describe('asset source conformance', () => {
  for (const kind of ['Memory', 'File', 'HTTP'] as const)
    it(`${kind} follows shared semantic checks`, async () => {
      const checks = await runConformance(async (records) => {
        if (kind === 'Memory') return new MemorySource(records, [ConformanceSlot]);
        if (kind === 'File') {
          const dir = await mkdtemp(join(tmpdir(), 'osw-file-'));
          await writeFile(
            join(dir, 'conformance.json'),
            JSON.stringify({ $example: 'synthetic', items: records }),
          );
          return FileSource.open(dir, [ConformanceSlot]);
        }
        return new HttpSource('https://example.com/osw/v1', {
          fetch: referenceFetch(new MemorySource(records, [ConformanceSlot])),
        });
      });
      expect(checks.filter((c) => !c.passed)).toEqual([]);
      expect(checks.length).toBeGreaterThan(20);
    });
});
describe('memory source failure paths', () => {
  it('keeps keyset identity through insertions between pages', async () => {
    const records = await conformanceRecords();
    const source = new MemorySource(records, [ConformanceSlot]);
    const p = await source.query(ConformanceSlot, null, {
      limit: 1,
      sort: [{ field: 'score', dir: 'asc' }],
    });
    const extra = { ...records[0], id: '5', data: { label: 'Inserted', score: 5 } };
    extra.versionHash = await versionHash(extra.data);
    source.add(extra);
    const ids = [p.items[0].id];
    let cursor = p.nextCursor;
    while (cursor) {
      const next = await source.query(ConformanceSlot, null, {
        limit: 1,
        sort: [{ field: 'score', dir: 'asc' }],
        cursor,
      });
      ids.push(...next.items.map((r) => r.id));
      cursor = next.nextCursor;
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('5');
    expect(records.every((r) => ids.includes(r.id))).toBe(true);
  });
  it('bounds leaf count/depth, scalar array lengths and spatial radius', async () => {
    const s = new MemorySource(await conformanceRecords());
    for (const filter of [
      { all: Array.from({ length: 33 }, () => ({ field: 'score', op: 'eq', value: 10 })) },
      { field: 'geo', op: 'within', value: { lat: 0, lng: 0, radiusKm: 101 } },
      { field: 'score', op: 'in', value: [] },
    ])
      await expect(s.query(ConformanceSlot, filter as any)).rejects.toMatchObject({
        code: 'invalid_filter',
      });
    await expect(s.query(ConformanceSlot, null, { cursor: 'nonsense' })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(
      s.query(ConformanceSlot, null, { sort: [{ field: 'note', dir: 'asc' }] }),
    ).rejects.toMatchObject({ code: 'sort_unsupported' });
  });
  it('serializes concurrent fills against the source version', async () => {
    const records = await conformanceRecords();
    const s = new MemorySource(records, [ConformanceSlot]);
    const f = {
      asset: { slot: records[0].slot, id: records[0].id, versionHash: records[0].versionHash },
      field: 'note',
      value: 'first',
      by: 'example:operator',
      at: '2026-01-01T00:00:00Z',
    };
    const result = await Promise.all([
      s.applyFills([f]),
      s.applyFills([{ ...f, value: 'second' }]),
    ]);
    expect(result.flat().map((r) => r.status)).toEqual(['recorded', 'source_changed']);
    expect((await s.get(ConformanceSlot, '1'))?.data.note).toBe('first');
  });
  it('does not mutate records on invalid fill paths or values', async () => {
    const slot = defineSlot({
      name: 'thing',
      schema: z.object({ nested: z.object({ value: z.number().optional() }).optional() }),
    });
    const record = {
      slot: 'thing',
      id: '1',
      slotVersion: '0.1.0',
      versionHash: await versionHash({}),
      coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
      updatedAt: '2026-01-01T00:00:00Z',
      data: {},
    } as AnyAssetRecord;
    const s = new MemorySource([record], [slot]);
    const f = {
      asset: { slot: 'thing', id: '1', versionHash: record.versionHash },
      field: 'nested.value',
      value: 'wrong',
      by: 'example:operator',
      at: '2026-01-01T00:00:00Z',
    };
    expect((await s.applyFills([f]))[0].status).toBe('rejected');
    expect((await s.get(slot, '1'))?.data).toEqual({});
  });
});
describe('file source formats and durable writes', () => {
  it('decodes the CSV example literal as a boolean before record validation', async () => {
    const record = (await conformanceRecords())[0];
    const csv = [
      'slot,id,slotVersion,versionHash,coverage.tier,updatedAt,example,data.label',
      `conformance,1,0.1.0,${record.versionHash},general,${record.updatedAt},true,Example label`,
    ].join('\n');
    const parsed = parseRecord(ConformanceSlot, recordsFromCsv(csv, ConformanceSlot)[0]);
    expect(parsed.example).toBe(true);
    expect(parsed.data.label).toBe('Example label');
    const invalid = recordsFromCsv(csv.replace(',true,', ',false,'), ConformanceSlot)[0];
    expect(() => parseRecord(ConformanceSlot, invalid)).toThrow();
    const literals = defineSlot({
      name: 'literal-types',
      schema: z.object({
        text: z.literal('true'),
        enabled: z.literal(false),
        number: z.literal(0),
      }),
    });
    expect(
      recordsFromCsv('data.text,data.enabled,data.number\ntrue,false,0', literals)[0].data,
    ).toEqual({ text: 'true', enabled: false, number: 0 });
  });
  it('reads NDJSON and CSV and replays write journals', async () => {
    const records = await conformanceRecords();
    const dir = await mkdtemp(join(tmpdir(), 'osw-formats-'));
    await writeFile(
      join(dir, 'conformance.ndjson'),
      `${JSON.stringify({ $example: 'synthetic' })}\n${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const source = await FileSource.open(dir, [ConformanceSlot]);
    const r = records[0];
    const fill = {
      asset: { slot: r.slot, id: r.id, versionHash: r.versionHash },
      field: 'note',
      value: 'verified',
      by: 'example:operator',
      at: '2026-01-01T00:00:00Z',
    };
    await source.applyFills([fill]);
    const reopened = await FileSource.open(dir, [ConformanceSlot]);
    expect((await reopened.get(ConformanceSlot, '1'))?.data.note).toBe('verified');
    expect(await readFile(join(dir, '_fills.ndjson'), 'utf8')).toContain('verified');
    const csv = 'id,data.label,data.tags,data.score\n1,"A, B",a;b,10\n';
    expect(recordsFromCsv(csv)[0]).toEqual({
      id: '1',
      data: { label: 'A, B', tags: ['a', 'b'], score: 10 },
    });
  });
  it('refuses ambiguous slot files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osw-ambiguous-'));
    await writeFile(join(dir, 'conformance.json'), '[]');
    await writeFile(join(dir, 'conformance.ndjson'), '');
    await expect(FileSource.open(dir, [ConformanceSlot])).rejects.toMatchObject({
      code: 'invalid_record',
    });
  });
});
describe('HTTP source trust boundary', () => {
  it.each([429, 503])('retries an HTML %i response before decoding JSON', async (status) => {
    const delays: number[] = [];
    let requests = 0;
    const source = new HttpSource('https://example.com/osw/v1', {
      fetch: (async () => {
        requests++;
        return requests === 1
          ? new Response('<html>Temporarily unavailable</html>', {
              status,
              headers: { 'Content-Type': 'text/html', 'Retry-After': '1' },
            })
          : Response.json({ items: [], nextCursor: null });
      }) as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(source.query(ConformanceSlot, null)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(requests).toBe(2);
    expect(delays).toEqual([1000]);
  });
  it('caps retries for HTML errors and does not retry malformed successful responses', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const source = new HttpSource('https://example.com', {
      fetch: (async () => {
        attempts++;
        return new Response('<html>Rate limit</html>', { status: 429 });
      }) as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(source.query(ConformanceSlot, null)).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    let successfulCalls = 0;
    const invalid = new HttpSource('https://example.com', {
      fetch: (async () => {
        successfulCalls++;
        return new Response('<html>Not an asset</html>');
      }) as typeof fetch,
    });
    await expect(invalid.query(ConformanceSlot, null)).rejects.toMatchObject({
      code: 'source_unavailable',
      status: 200,
    });
    expect(successfulCalls).toBe(1);
  });
  it('uses bounded retries, forwards auth, and returns ordered statuses', async () => {
    let requests = 0;
    const delays: number[] = [];
    const fetcher = (async (_url, init) => {
      requests++;
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer example-token');
      expect(init?.redirect).toBe('error');
      if (requests < 3)
        return Response.json(
          { error: { code: 'rate_limited', message: 'retry' } },
          { status: 429, headers: { 'Retry-After': '0' } },
        );
      return Response.json({ items: [], nextCursor: null });
    }) as typeof fetch;
    await new HttpSource('https://example.com/osw/v1', {
      token: 'example-token',
      fetch: fetcher,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).query(ConformanceSlot, null);
    expect(requests).toBe(3);
    expect(delays).toEqual([0, 0]);
  });
  it('does not retry permission errors or disguise a missing slot as missing record', async () => {
    let requests = 0;
    const s = new HttpSource('https://example.com', {
      fetch: (async () => {
        requests++;
        return Response.json(
          { error: { code: 'field_forbidden', message: 'hidden' } },
          { status: 403 },
        );
      }) as typeof fetch,
    });
    await expect(s.query(ConformanceSlot, null)).rejects.toMatchObject({
      code: 'field_forbidden',
      status: 403,
    });
    expect(requests).toBe(1);
    const missing = new HttpSource('https://example.com', {
      fetch: (async () =>
        Response.json(
          { error: { code: 'slot_not_found', message: 'missing slot' } },
          { status: 404 },
        )) as typeof fetch,
    });
    await expect(missing.get(ConformanceSlot, '1')).rejects.toMatchObject({
      code: 'slot_not_found',
    });
  });
  it('rejects oversized and malformed source responses', async () => {
    const records = await conformanceRecords();
    const s = new HttpSource('https://example.com', {
      fetch: (async () => Response.json({ items: records, nextCursor: null })) as typeof fetch,
    });
    await expect(s.query(ConformanceSlot, null, { limit: 1 })).rejects.toMatchObject({
      code: 'source_unavailable',
    });
  });
});

describe('source review regressions', () => {
  it('serializes separate FileSource instances and guards stale writes', async () => {
    const records = await conformanceRecords();
    const dir = await mkdtemp(join(tmpdir(), 'osw-multi-instance-'));
    await writeFile(
      join(dir, 'conformance.json'),
      JSON.stringify({ $example: 'synthetic', items: records }),
    );
    const first = await FileSource.open(dir, [ConformanceSlot]);
    const second = await FileSource.open(dir, [ConformanceSlot]);
    const base = {
      asset: { slot: records[0].slot, id: records[0].id, versionHash: records[0].versionHash },
      field: 'note',
      value: 'first',
      by: 'example:operator',
      at: '2026-01-01T00:00:00Z',
    };
    expect((await first.applyFills([base]))[0].status).toBe('recorded');
    expect((await second.applyFills([{ ...base, value: 'second' }]))[0].status).toBe(
      'source_changed',
    );
    expect((await FileSource.open(dir, [ConformanceSlot])).snapshot()[0].data.note).toBe('first');
  });
  it('prevents stale fills across separate Node processes', async () => {
    const { spawn } = await import('node:child_process');
    const records = await conformanceRecords();
    const dir = await mkdtemp(join(tmpdir(), 'osw-multi-process-'));
    await writeFile(
      join(dir, 'conformance.json'),
      JSON.stringify({ $example: 'synthetic', items: records }),
    );
    const fileSourceUrl = new URL('../src/node/file-source.ts', import.meta.url).href;
    const slotUrl = new URL('../src/conformance/index.ts', import.meta.url).href;
    const run = (value: string) =>
      new Promise<string>((resolve, reject) => {
        const fill = {
          asset: { slot: records[0].slot, id: records[0].id, versionHash: records[0].versionHash },
          field: 'note',
          value,
          by: 'example:operator',
          at: '2026-01-01T00:00:00Z',
        };
        const program = `import {FileSource} from ${JSON.stringify(fileSourceUrl)};import {ConformanceSlot} from ${JSON.stringify(slotUrl)};const source=await FileSource.open(process.argv[1],[ConformanceSlot]);const results=await source.applyFills([JSON.parse(process.argv[2])]);process.stdout.write(results[0].status);`;
        const child = spawn(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          program,
          dir,
          JSON.stringify(fill),
        ]);
        let output = '';
        let errors = '';
        child.stdout.on('data', (data) => {
          output += String(data);
        });
        child.stderr.on('data', (data) => {
          errors += String(data);
        });
        child.once('error', reject);
        child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(errors))));
      });
    expect((await Promise.all([run('first'), run('second')])).sort()).toEqual([
      'recorded',
      'source_changed',
    ]);
  });
  it('does not replay old fill snapshots over externally updated assets', async () => {
    const records = await conformanceRecords();
    const dir = await mkdtemp(join(tmpdir(), 'osw-external-update-'));
    const path = join(dir, 'conformance.json');
    await writeFile(path, JSON.stringify({ items: records }));
    const source = await FileSource.open(dir, [ConformanceSlot]);
    await source.applyFills([
      {
        asset: { slot: records[0].slot, id: records[0].id, versionHash: records[0].versionHash },
        field: 'note',
        value: 'old fill',
        by: 'example:operator',
        at: '2026-01-01T00:00:00Z',
      },
    ]);
    records[0].data = { ...records[0].data, label: 'Externally revised', note: 'external value' };
    records[0].versionHash = await versionHash(records[0].data);
    await writeFile(path, JSON.stringify({ items: records }));
    await expect(FileSource.open(dir, [ConformanceSlot])).rejects.toMatchObject({
      code: 'journal_conflict',
    });
    expect(JSON.parse(await readFile(path, 'utf8')).items[0].data).toMatchObject({
      label: 'Externally revised',
      note: 'external value',
    });
  });
  it('rejects fills on undeclared fields rather than reporting stripped success', async () => {
    const records = await conformanceRecords();
    const source = new MemorySource(records, [ConformanceSlot]);
    const result = await source.applyFills([
      {
        asset: { slot: records[0].slot, id: records[0].id, versionHash: records[0].versionHash },
        field: 'missingField',
        value: 'invalid',
        by: 'example:operator',
        at: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(result[0].status).toBe('rejected');
    expect((await source.get(ConformanceSlot, '1'))?.versionHash).toBe(records[0].versionHash);
  });
  it('sorts missing coordinates consistently under a spatial OR filter', async () => {
    const source = new MemorySource(await conformanceRecords());
    const page = await source.query(
      ConformanceSlot,
      {
        any: [
          { field: 'geo', op: 'within', value: { lat: 0, lng: 0, radiusKm: 1 } },
          { field: 'label', op: 'eq', value: 'Delta Four' },
        ],
      },
      { sort: [{ field: '_distance', dir: 'asc' }] },
    );
    expect(page.items.map((r) => r.id)).toEqual(['4', '1']);
  });
  it('backs off when Retry-After is absent and stops after three retries', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const source = new HttpSource('https://example.com', {
      fetch: (async () => {
        attempts++;
        return Response.json(
          { error: { code: 'source_unavailable', message: 'unavailable' } },
          { status: 503 },
        );
      }) as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(source.query(ConformanceSlot, null)).rejects.toMatchObject({ status: 503 });
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(attempts).toBe(4);
  });
});

describe('fieldset guarded fill replay', () => {
  it('preserves external changes in other fieldsets when replaying fills', async () => {
    const slot = defineSlot({
      name: 'fieldset-example',
      schema: z.object({ label: z.string(), note: z.string().nullable() }),
      fieldsets: { identity: ['label'], notes: ['note'] },
    });
    const original = { label: 'Original label', note: null };
    const record = {
      slot: slot.name,
      id: '1',
      slotVersion: '0.1.0',
      versionHash: await versionHash(original),
      fieldsetHashes: {
        identity: await versionHash({ label: original.label }),
        notes: await versionHash({ note: null }),
      },
      coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
      updatedAt: '2026-01-01T00:00:00Z',
      data: original,
    } as AnyAssetRecord;
    const dir = await mkdtemp(join(tmpdir(), 'osw-fieldset-'));
    const path = join(dir, `${slot.name}.json`);
    await writeFile(path, JSON.stringify({ items: [record] }));
    const source = await FileSource.open(dir, [slot]);
    expect(
      (
        await source.applyFills([
          {
            asset: {
              slot: slot.name,
              id: '1',
              versionHash: record.fieldsetHashes!.notes,
              fieldset: 'notes',
            },
            field: 'note',
            value: 'verified note',
            by: 'example:operator',
            at: '2026-01-01T00:00:00Z',
          },
        ])
      )[0].status,
    ).toBe('recorded');
    record.data.label = 'Externally revised label';
    record.versionHash = await versionHash(record.data);
    record.fieldsetHashes!.identity = await versionHash({ label: record.data.label });
    await writeFile(path, JSON.stringify({ items: [record] }));
    const reopened = await FileSource.open(dir, [slot]);
    expect((await reopened.get(slot, '1'))?.data).toEqual({
      label: 'Externally revised label',
      note: 'verified note',
    });
  });
  it('rejects using an unrelated fieldset to authorize a fill', async () => {
    const slot = defineSlot({
      name: 'fieldset-example',
      schema: z.object({ label: z.string().nullable(), note: z.string().nullable() }),
      fieldsets: { identity: ['label'], notes: ['note'] },
    });
    const data = { label: null, note: null };
    const record = {
      slot: slot.name,
      id: '1',
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      fieldsetHashes: {
        identity: await versionHash({ label: null }),
        notes: await versionHash({ note: null }),
      },
      coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
      updatedAt: '2026-01-01T00:00:00Z',
      data,
    } as AnyAssetRecord;
    const source = new MemorySource([record], [slot]);
    expect(
      (
        await source.applyFills([
          {
            asset: {
              slot: slot.name,
              id: '1',
              versionHash: record.fieldsetHashes!.notes,
              fieldset: 'notes',
            },
            field: 'label',
            value: 'unauthorized change',
            by: 'example:operator',
            at: '2026-01-01T00:00:00Z',
          },
        ])
      )[0].status,
    ).toBe('rejected');
    expect((await source.get(slot, '1'))?.data.label).toBeNull();
  });
});
