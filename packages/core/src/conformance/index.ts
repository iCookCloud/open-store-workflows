import { z } from '../base.js';
import { OswSourceError } from '../errors.js';
import type { Filter } from '../filter.js';
import { versionHash } from '../hash.js';
import { type AnyAssetRecord, defineSlot } from '../slot.js';
import type { AssetSource } from '../source.js';
export const ConformanceSlot = defineSlot({
  name: 'conformance',
  schema: z.object({
    label: z.string().optional(),
    score: z.number().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    jurisdiction: z.string().optional(),
    geo: z.object({ lat: z.number(), lng: z.number() }).optional(),
    lanes: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
    note: z.string().nullable().optional(),
    reviewNote: z.string().optional(),
    paramKey: z.string().optional(),
  }),
  filterable: {
    label: ['eq', 'in', 'contains', 'exists'],
    score: ['eq', 'in', 'gte', 'lte', 'exists'],
    tags: ['hasAny', 'hasAll', 'exists'],
    jurisdiction: ['prefix', 'eq'],
    geo: ['within'],
    note: ['exists'],
    paramKey: ['keyPrefix'],
    'lanes[].from': ['eq'],
    'lanes[].to': ['eq'],
  },
  sortable: ['score', 'label'],
});
export async function conformanceRecords(): Promise<AnyAssetRecord[]> {
  const data = [
    {
      label: 'Alpha One',
      paramKey: 'labor.rate',
      score: 10,
      tags: ['a', 'b'],
      jurisdiction: 'XE-AA',
      geo: { lat: 0, lng: 0 },
      lanes: [
        { from: 'XE', to: 'XF' },
        { from: 'XG', to: 'XH' },
      ],
      note: null,
    },
    {
      label: 'Beta Two',
      paramKey: 'labor.rate.special',
      score: 20,
      tags: ['b'],
      jurisdiction: 'XE-AAX',
      geo: { lat: 0, lng: 0.01 },
      note: 'set',
    },
    { label: 'Gamma Three', score: null, tags: [], jurisdiction: 'XF', geo: { lat: 20, lng: 20 } },
    { label: 'Delta Four', paramKey: 'labor.rateExtra' },
  ];
  return Promise.all(
    data.map(async (data, i) => ({
      slot: ConformanceSlot.name,
      id: String(i + 1),
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      coverage: { tier: 'general' as const, tracks: [], workflows: [], jurisdictions: [] },
      updatedAt: '2026-01-01T00:00:00Z',
      example: true as const,
      data,
    })),
  );
}
export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail?: string;
}
export async function runConformance(
  create: (records: AnyAssetRecord[]) => Promise<AssetSource> | AssetSource,
): Promise<ConformanceCheck[]> {
  const source = await create(await conformanceRecords());
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({
        name,
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const expectIds = async (filter: Filter | null, ids: string[]) => {
    const p = await source.query(ConformanceSlot, filter, { limit: 200 });
    if (JSON.stringify(p.items.map((r) => r.id)) !== JSON.stringify(ids))
      throw new Error(`Expected ${ids}, got ${p.items.map((r) => r.id)}`);
  };
  const cases: [string, Filter, string[]][] = [
    ['eq', { field: 'score', op: 'eq', value: 10 }, ['1']],
    ['in', { field: 'score', op: 'in', value: [10, 20] }, ['1', '2']],
    ['gte', { field: 'score', op: 'gte', value: 20 }, ['2']],
    ['lte', { field: 'score', op: 'lte', value: 10 }, ['1']],
    ['contains insensitive', { field: 'label', op: 'contains', value: 'ONE' }, ['1']],
    ['hasAny', { field: 'tags', op: 'hasAny', value: ['a'] }, ['1']],
    ['hasAll', { field: 'tags', op: 'hasAll', value: ['a', 'b'] }, ['1']],
    ['exists includes nonempty only', { field: 'tags', op: 'exists', value: true }, ['1', '2']],
    ['exists false missing and null', { field: 'score', op: 'exists', value: false }, ['3', '4']],
    ['prefix segment boundary', { field: 'jurisdiction', op: 'prefix', value: 'XE-AA' }, ['1']],
    [
      'parameter namespace boundary',
      { field: 'paramKey', op: 'keyPrefix', value: 'labor.rate' },
      ['1', '2'],
    ],
    ['within', { field: 'geo', op: 'within', value: { lat: 0, lng: 0, radiusKm: 2 } }, ['1', '2']],
    [
      'array traversal coarse AND',
      {
        all: [
          { field: 'lanes[].from', op: 'eq', value: 'XE' },
          { field: 'lanes[].to', op: 'eq', value: 'XH' },
        ],
      },
      ['1'],
    ],
    ['not', { not: { field: 'score', op: 'gte', value: 10 } }, ['3', '4']],
    [
      'any',
      {
        any: [
          { field: 'score', op: 'eq', value: 10 },
          { field: 'label', op: 'eq', value: 'Gamma Three' },
        ],
      },
      ['1', '3'],
    ],
  ];
  for (const [name, f, ids] of cases) await check(`filter/${name}`, () => expectIds(f, ids));
  await check('keyset pagination', async () => {
    const p1 = await source.query(ConformanceSlot, null, {
      limit: 2,
      sort: [{ field: 'score', dir: 'asc' }],
    });
    const p2 = await source.query(ConformanceSlot, null, {
      limit: 2,
      sort: [{ field: 'score', dir: 'asc' }],
      cursor: p1.nextCursor,
    });
    if (
      p1.items.length !== 2 ||
      p2.items.length !== 2 ||
      new Set([...p1.items, ...p2.items].map((r) => r.id)).size !== 4 ||
      p2.nextCursor !== null
    )
      throw new Error('Pagination lost or duplicated records');
  });
  await check('cursor query binding', async () => {
    const p = await source.query(ConformanceSlot, null, { limit: 1 });
    try {
      await source.query(
        ConformanceSlot,
        { field: 'score', op: 'eq', value: 10 },
        { cursor: p.nextCursor },
      );
      throw new Error('Cursor accepted altered query');
    } catch (e) {
      if (!(e instanceof OswSourceError) || e.code !== 'invalid_cursor') throw e;
    }
  });
  await check('get missing', async () => {
    if ((await source.get(ConformanceSlot, 'absent')) !== null)
      throw new Error('Missing record not null');
  });
  await check('invalid limit', async () => {
    try {
      await source.query(ConformanceSlot, null, { limit: 201 });
      throw new Error('Invalid limit accepted');
    } catch (e) {
      if (!(e instanceof OswSourceError) || e.code !== 'invalid_limit') throw e;
    }
  });
  await check('unsupported filter', async () => {
    try {
      await source.query(ConformanceSlot, { field: 'unknown', op: 'eq', value: 1 });
      throw new Error('Unsupported field accepted');
    } catch (e) {
      if (!(e instanceof OswSourceError) || e.code !== 'filter_unsupported') throw e;
    }
  });
  await check('count', async () => {
    if (!source.count) throw new Error('Count absent');
    const g = await source.count(ConformanceSlot, null, {
      groupBy: [{ field: 'jurisdiction', depth: 1 }],
    });
    if (g.find((g) => g.key[0] === 'XE')?.n !== 2)
      throw new Error('Incorrect jurisdiction grouping');
  });
  await check('verification source guard and idempotency', async () => {
    const r = (await source.get(ConformanceSlot, '1'))!;
    const v = {
      asset: { slot: r.slot, id: r.id, versionHash: r.versionHash },
      purpose: 'store-concept/calibrate',
      verdict: 'fails' as const,
      reason: 'Synthetic discrepancy',
      at: '2026-01-01T00:00:00Z',
      by: 'example:conformance',
    };
    const results = await source.recordVerification([
      v,
      v,
      { ...v, asset: { ...v.asset, versionHash: '0'.repeat(64) } },
    ]);
    if (results.map((r) => r.status).join() !== 'recorded,duplicate,source_changed')
      throw new Error('Verification guard failed');
  });
  await check('fills only empty and version guarded', async () => {
    if (!source.applyFills) throw new Error('Fills absent');
    const r = (await source.get(ConformanceSlot, '1'))!;
    const r2 = (await source.get(ConformanceSlot, '2'))!;
    const f = {
      asset: { slot: r.slot, id: r.id, versionHash: r.versionHash },
      field: 'note',
      value: 'verified',
      by: 'example:operator',
      at: '2026-01-01T00:00:00Z',
    };
    const results = await source.applyFills([
      f,
      { ...f, asset: { slot: r2.slot, id: r2.id, versionHash: r2.versionHash } },
      { ...f, value: 'overwrite' },
      { ...f, field: 'reviewNote', value: 'Second verified field' },
    ]);
    if (results.map((r) => r.status).join() !== 'recorded,not_empty,not_empty,recorded')
      throw new Error('Fill guards failed');
    const filled = await source.get(ConformanceSlot, '1');
    if (filled?.data.note !== 'verified' || filled.versionHash === r.versionHash)
      throw new Error('Fill not persisted/versioned');
    if (filled.data.reviewNote !== 'Second verified field') throw new Error('Second fill lost');
    const stale = await source.applyFills([{ ...f, value: 'Stale later call' }]);
    if (stale[0].status !== 'source_changed') throw new Error('Cross-call version guard lost');
  });
  await check('redacted filter and grouping are forbidden', async () => {
    const records = await conformanceRecords();
    const hidden = { ...records[0], data: { label: 'Visible' }, redacted: ['/data/score'] };
    const restricted = await create([hidden]);
    for (const operation of [
      () => restricted.query(ConformanceSlot, { field: 'score', op: 'gte', value: 0 }),
      () => restricted.count!(ConformanceSlot, null, { groupBy: ['score'] }),
    ]) {
      try {
        await operation();
        throw new Error('Hidden field operation accepted');
      } catch (error) {
        if (
          !(error instanceof OswSourceError) ||
          error.code !== 'field_forbidden' ||
          error.status !== 403
        )
          throw error;
      }
    }
  });
  return checks;
}
