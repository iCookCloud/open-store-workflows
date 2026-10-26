import { describe, expect, it } from 'vitest';
import {
  ARTIFACTS,
  AssetRecord,
  MemorySource,
  Offer,
  OfferSlot,
  Requirement,
  SHARED_SLOTS,
  addDays,
  convertMoney,
  convertUnit,
  createParamReader,
  defineSlot,
  diffDays,
  divMoney,
  isWithin,
  jurisdictionPrefixes,
  meets,
  normalize,
  parseRecord,
  resolveParam,
  roundMoney,
  slotJsonSchema,
  sumMoney,
  todayIn,
  unitPriceAt,
  validateRequirement,
  versionHash,
  z,
} from '../src/index.js';
import type { AnyAssetRecord } from '../src/index.js';
import { prepareContext } from '../src/node/runner.js';
const time = '2026-01-01T00:00:00Z';
async function record(slot: string, id: string, data: unknown): Promise<AnyAssetRecord> {
  return {
    slot,
    id,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
    updatedAt: time,
    data,
  };
}
describe('review: runner parameter hydration', () => {
  it('loads qualified prices and dynamic FX while keeping parameter namespaces separate', async () => {
    const records = await Promise.all([
      record('params', 'base', { key: 'labor.rate', value: 1 }),
      record('params', 'specific', { key: 'labor.rate.special', value: 4 }),
      record('params', 'other', { key: 'labor.rateExtra.special', value: 99 }),
      record('params', 'fx', { key: 'fx.EUR.USD', value: 2 }),
      ...Array.from({ length: 205 }, (_, i) =>
        record('params', `page-${i}`, { key: `labor.rate.item${i}`, value: i }),
      ),
    ]);
    const ctx = await prepareContext(
      [
        {
          id: 'store-concept/price',
          input: z.object({}),
          output: z.unknown(),
          reads: ['params'],
          params: [{ key: 'labor.rate', required: true, description: 'Labor price' }],
          run: async () => ({ output: {}, needs: [], verifications: [] }),
        },
      ],
      {},
      { source: new MemorySource(records), now: time },
    );
    expect(ctx.params.get('labor.rate', { qualifier: 'special' })?.value).toBe(4);
    expect(ctx.params.get('labor.rate', { qualifier: 'item204' })?.value).toBe(204);
    expect(ctx.params.get('labor.rateExtra', { qualifier: 'special' })).toBeUndefined();
    expect(ctx.params.get('fx.EUR.USD')?.value).toBe(2);
    expect(ctx.params.refs?.('labor.rate', { qualifier: 'special' })?.[0].id).toBe('specific');
  });
});
describe('review: condition unit safety', () => {
  it('does not compare dimensional thresholds without a declared unit', () => {
    const result = meets(
      { key: 'area', op: 'gte', value: 100, hard: true },
      { key: 'area', measure: { value: 1000, unit: 'ft2' } },
    );
    expect(result.value).toBeNull();
    expect(result.needs).toContainEqual(expect.objectContaining({ kind: 'input', blocking: true }));
    expect(
      meets(
        { key: 'area', op: 'gte', value: 100, unit: 'm2', hard: true },
        { key: 'area', measure: { value: 1000, unit: 'ft2' } },
      ).value,
    ).toBe(false);
  });
});
describe('canonical hash', () => {
  it('matches both protocol golden vectors', async () => {
    expect(
      await versionHash({
        name: { zh: '示例椅', en: 'Sample Chair' },
        goodsClass: 'nonfood',
        netWeightKg: 4.5,
        images: [`sha256:${'0'.repeat(64)}`],
      }),
    ).toBe('4579f2045365d658027ed69e583bc57210b3ad1eecef6cd58d7037f4405cbf7c');
    expect(
      await versionHash({
        b: 1,
        a: [' x', null, ''],
        c: '',
        d: {},
        e: [],
        f: { g: undefined, h: Number.NaN },
      }),
    ).toBe('e865ad6464809142196deb6ef7f9b73a9d85020faec31f905ab821a8918a7efc');
  });
  it('keeps array ordering and removes empty object members', () => {
    expect(normalize({ z: [], a: [1, null, 2], b: { c: null } })).toEqual({ a: [1, null, 2] });
  });
  it('handles prototype-shaped keys without losing data', () => {
    expect(JSON.stringify(normalize(JSON.parse('{"__proto__":1,"constructor":2}')))).toBe(
      '{"__proto__":1,"constructor":2}',
    );
  });
});
describe('money and deterministic dates', () => {
  it('rounds currency-specific minor units and mixed sums refuse', () => {
    expect(roundMoney({ amount: 2.55, currency: 'JPY' }).amount).toBe(3);
    expect(roundMoney({ amount: 1.2345, currency: 'KWD' }).amount).toBe(1.235);
    expect(roundMoney({ amount: 1.005, currency: 'USD' }).amount).toBe(1.01);
    expect(() =>
      sumMoney([
        { amount: 1, currency: 'USD' },
        { amount: 1, currency: 'JPY' },
      ]),
    ).toThrow();
    expect(divMoney({ amount: 2, currency: 'USD' }, 0)).toBeNull();
  });
  it('uses injected time and UTC date arithmetic across DST', () => {
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(diffDays('2026-03-09', '2026-03-08')).toBe(1);
    expect(todayIn('America/New_York', '2026-01-01T01:00:00Z')).toBe('2025-12-31');
  });
});
describe('conditions', () => {
  it('keeps extendable schema objects', () => {
    expect(() => Requirement.extend({ reason: z.string() })).not.toThrow();
  });
  it('converts within families and returns need for mixed families', () => {
    expect(convertUnit(1, 'ft2', 'm2').value).toBeCloseTo(0.09290304);
    expect(convertUnit(1, 'kg', 'm2').needs[0].blocking).toBe(true);
  });
  it('checks numeric and categorical conditions and refuses invalid units', () => {
    expect(
      meets(
        { key: 'area', op: 'gte', value: 90, unit: 'm2', hard: true },
        { key: 'area', measure: { value: 1000, unit: 'ft2' } },
      ).value,
    ).toBe(true);
    expect(
      meets(
        { key: 'exhaustPath', op: 'in', value: ['existing', 'feasible'], hard: true },
        { key: 'exhaustPath', measure: { value: 'none' } },
      ).value,
    ).toBe(false);
    expect(() =>
      validateRequirement({ key: 'area', op: 'gte', value: 2, unit: 'kg', hard: true }),
    ).toThrow();
  });
});
describe('scoped parameters', () => {
  it('chooses qualifier, jurisdiction, track and date in that order', async () => {
    const rows = await Promise.all(
      [
        { key: 'labor.rate', value: 1 },
        { key: 'labor.rate', value: 2, appliesTo: { jurisdictions: ['XE'] } },
        {
          key: 'labor.rate',
          value: 3,
          appliesTo: { jurisdictions: ['XE-AA'], tracks: ['sample'] },
        },
        { key: 'labor.rate.special', value: 4 },
      ].map((data, i) => record('params', String(i), data)),
    );
    expect(
      resolveParam(rows, 'labor.rate', time, { jurisdiction: 'XE-AA', track: 'sample' }).value
        ?.value,
    ).toBe(3);
    expect(
      resolveParam(rows, 'labor.rate', time, {
        jurisdiction: 'XE-AA',
        track: 'sample',
        qualifier: 'special',
      }).value?.value,
    ).toBe(4);
  });
  it('rejects expired/future values and exposes ambiguous independently', async () => {
    const rows = await Promise.all(
      [
        { key: 'labor.rate', value: 1, validTo: '2025-12-31' },
        { key: 'labor.rate', value: 2, validFrom: '2026-01-02' },
        { key: 'labor.rate', value: 3 },
        { key: 'labor.rate', value: 4 },
      ].map((data, i) => record('params', String(i), data)),
    );
    const p = createParamReader(rows, time);
    expect(p.get('labor.rate')).toBeUndefined();
    expect(p.need?.('labor.rate')?.reason).toBe('ambiguous');
    expect(convertMoney({ amount: 1, currency: 'USD' }, 'JPY', p).needs[0]).toMatchObject({
      reason: 'missing',
    });
  });
  it('prefers newest validFrom after specificity and converts only money values', async () => {
    const rows = await Promise.all(
      [
        { key: 'fx.USD.JPY', value: 100, validFrom: '2025-01-01' },
        { key: 'fx.USD.JPY', value: 200, validFrom: '2025-12-01' },
      ].map((data, i) => record('params', String(i), data)),
    );
    expect(
      convertMoney({ amount: 1.01, currency: 'USD' }, 'JPY', createParamReader(rows, time)).value,
    ).toEqual({ amount: 202, currency: 'JPY' });
  });
});
describe('parameter provenance', () => {
  it('reports only the uniquely resolved source record', async () => {
    const broad = await record('params', 'broad', { key: 'concept.budgetBand', value: 0.2 });
    const local = await record('params', 'local', {
      key: 'concept.budgetBand',
      value: 0.1,
      appliesTo: { jurisdictions: ['XE-AA'] },
    });
    const reader = createParamReader([broad, local], time, { jurisdiction: 'XE-AA' });
    expect(reader.refs?.('concept.budgetBand')).toEqual([
      { slot: 'params', id: 'local', versionHash: local.versionHash },
    ]);
    expect(reader.refs?.('concept.areaTolerance')).toEqual([]);
    const ambiguous = createParamReader([local, { ...local, id: 'duplicate' }], time, {
      jurisdiction: 'XE-AA',
    });
    expect(ambiguous.refs?.('concept.budgetBand')).toEqual([]);
  });
});
describe('schema contracts', () => {
  it('exports JSON Schema for all nine slots and seven bodies', () => {
    expect(SHARED_SLOTS).toHaveLength(9);
    expect(Object.keys(ARTIFACTS)).toHaveLength(7);
    for (const slot of SHARED_SLOTS) expect(slotJsonSchema(slot)).toBeTruthy();
    for (const item of Object.values(ARTIFACTS))
      expect(z.toJSONSchema(item.body, { io: 'input' })).toBeTruthy();
  });
  it('keeps source hash and strips unknown compatible minor fields', async () => {
    const slot = defineSlot({ name: 'thing', schema: z.object({ label: z.string() }) });
    const r = await record('thing', '1', { label: 'Visible', future: 1 });
    r.slotVersion = '0.2.0';
    expect(parseRecord(slot, r).data).toEqual({ label: 'Visible' });
    expect(parseRecord(slot, r).versionHash).toBe(r.versionHash);
    r.slotVersion = '1.0.0';
    expect(() => parseRecord(slot, r)).toThrowError(/major/);
  });
  it('permits explicitly redacted required fields but refuses filtering them', async () => {
    const slot = defineSlot({
      name: 'thing',
      schema: z.object({ label: z.string(), secret: z.number() }),
      filterable: { secret: ['gte'] },
    });
    const r = await record('thing', '1', { label: 'Visible' });
    r.redacted = ['/data/secret'];
    const source = new MemorySource([r]);
    expect((await source.get(slot, '1'))?.data.label).toBe('Visible');
    await expect(
      source.query(slot, { field: 'secret', op: 'gte', value: 0 }),
    ).rejects.toMatchObject({ code: 'field_forbidden', status: 403 });
  });
  it('enforces offer cross-field parse validation and tier lookup', async () => {
    const data = Offer.parse({
      partyId: 'example-supplier',
      productId: 'example-product',
      basis: 'quote',
      use: 'project',
      currency: 'USD',
      unit: 'pcs',
      tiers: [
        { minQty: 1, unitPrice: 20 },
        { minQty: 10, unitPrice: 10 },
      ],
      quotedAt: '2026-01-01',
    });
    expect(unitPriceAt(data, 10)).toEqual({ amount: 10, currency: 'USD' });
    const r = await record('offer', '1', { ...data, serviceScope: 'install' });
    r.fieldsetHashes = { price: '0'.repeat(64), terms: '0'.repeat(64) };
    expect(() => parseRecord(OfferSlot, r)).toThrow(/exclusively/);
  });
  it('requires valid record metadata', () => {
    expect(AssetRecord(z.unknown()).safeParse({ slot: 'product' }).success).toBe(false);
    expect(jurisdictionPrefixes('XE-AA-ABC')).toEqual(['XE', 'XE-AA', 'XE-AA-ABC']);
    expect(isWithin('XE-AAX', 'XE-AA')).toBe(false);
  });
});

describe('lawyer profile contract', () => {
  it('preserves owned, partner and absent service options and rejects invalid stance', async () => {
    const { LawyerProfile } = await import('../src/index.js');
    const profile = {
      matters: ['lease'],
      stance: 'tenant',
      caseTypes: [],
      chinaLanding: 'partner',
      engagement: ['matter'],
    };
    for (const chinaLanding of ['own', 'partner', 'none'])
      expect(LawyerProfile.parse({ ...profile, chinaLanding }).chinaLanding).toBe(chinaLanding);
    expect(LawyerProfile.safeParse({ ...profile, chinaLanding: false }).success).toBe(false);
    expect(LawyerProfile.safeParse({ ...profile, stance: 'unknown' }).success).toBe(false);
  });
});
