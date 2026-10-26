import { describe, expect, it } from 'vitest';
import { inspectDerives, mergeDerives } from '../src/derives.js';
import { type SpecRequirement, mergeRequirements } from '../src/requirements.js';
const req = (value: Partial<SpecRequirement>): SpecRequirement => ({
  key: 'area',
  op: 'gte',
  value: 10,
  unit: 'm2',
  hard: true,
  basis: 'user',
  reason: 'Example requirement',
  ...value,
});
describe('merge machine-readable requirements', () => {
  it('converts square feet to square metres and chooses strongest compatible bounds', () => {
    const merged = mergeRequirements([
      req({ value: 100 }),
      req({ value: 1200, unit: 'ft2' }),
      req({ op: 'lte', value: 150 }),
    ]);
    expect(merged.needs).toEqual([]);
    expect(merged.requirements.find((r) => r.op === 'gte')!.value).toBeCloseTo(111.483648);
  });
  it('hard requirements replace soft preferences without promoting them', () => {
    const merged = mergeRequirements([req({ value: 80 }), req({ value: 150, hard: false })]);
    expect(merged.requirements[0]!.value).toBe(80);
  });
  it('merges enum intersections and eq constraints', () => {
    const merged = mergeRequirements([
      req({ key: 'exhaustPath', unit: undefined, op: 'in', value: ['existing', 'feasible'] }),
      req({ key: 'exhaustPath', unit: undefined, op: 'eq', value: 'existing' }),
    ]);
    expect(merged.requirements[0]).toMatchObject({
      key: 'exhaustPath',
      op: 'eq',
      value: 'existing',
    });
  });
  it.each([
    [req({ value: 150 }), req({ op: 'lte', value: 100 })],
    [req({ op: 'in', value: [100] }), req({ op: 'in', value: [200] })],
    [req({ value: 100 }), req({ value: 10, unit: 'kg' })],
  ])('conflicts become explicit action needs', (...requirements) => {
    expect(mergeRequirements(requirements).needs).toContainEqual(
      expect.objectContaining({
        kind: 'action',
        action: 'resolveRequirementConflict',
        blocking: true,
      }),
    );
  });
});
describe('menu derivation integrity', () => {
  const derives = {
    ingredients: [{ key: 'example-flour' }],
    equipment: [],
    sop: [],
    coldchain: false,
  };
  it('unknown derivations never silently become no coldchain', () => {
    expect(mergeDerives([undefined], false).coldchain).toBeNull();
    expect(mergeDerives([derives, { ...derives, coldchain: true }], false).coldchain).toBe(true);
  });
  it('invalid coldchain and completely empty derivations fail inspection', () => {
    expect(inspectDerives({ ...derives, coldchain: 'false' }).valid).toBe(false);
    expect(
      inspectDerives({ ingredients: [], equipment: [], sop: [], coldchain: false }).valid,
    ).toBe(false);
  });
  it('merges terms once and nonfood always removes food/coldchain', () => {
    expect(mergeDerives([derives, derives], false).ingredients).toEqual([{ key: 'example-flour' }]);
    expect(mergeDerives([derives], true)).toMatchObject({ ingredients: [], coldchain: false });
  });
});
