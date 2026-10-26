import {
  BomLine,
  Component,
  type Component as ComponentType,
  assetRef,
  convertUnit,
} from '@osw/core';
import { describe, expect, it } from 'vitest';
import { generateComponents } from '../src/price/geometry.js';
import { priceLine } from '../src/price/model.js';
import { resolveQuantities } from '../src/price/qty.js';
import { materialRateSlot } from '../src/slots/index.js';
import { context, line, money, record } from './fixtures.js';
describe('BOM contract', () => {
  it('rejects missing custom parts, ambiguous rates and non-core units', () => {
    expect(BomLine.safeParse(line({ components: [] })).success).toBe(false);
    expect(
      Component.safeParse({
        ...line().components[0],
        rateRef: { slot: 'material-rate', id: 'x', versionHash: '0'.repeat(64) },
      }).success,
    ).toBe(false);
    expect(BomLine.safeParse({ ...line(), unit: 'piece' }).success).toBe(false);
    expect(Component.safeParse({ ...line().components[0], rateNote: undefined }).success).toBe(
      false,
    );
  });
});
describe('pricing golden calculations', () => {
  it.each([
    ['fixed', 1],
    ['length', 2],
    ['area', 2],
    ['front', 6],
    ['side', 3],
    ['volume', 6],
    ['skin', 22],
    ['cylinder', 6 * Math.PI],
  ] as const)('%s geometry has expected quantity', (basis, quantity) => {
    const input = line({
      dimensionsMm: { l: 2000, w: 1000, h: 3000 },
      components: [{ ...line().components[0], basis, rate: money(10) }],
    });
    const priced = priceLine(input, 'USD', new Map(), context());
    expect(priced.line.parts[0].qty).toBeCloseTo(quantity);
    expect(priced.line.modelCostPerUnit?.amount).toBeCloseTo(Math.round(quantity * 1000) / 100);
  });
  it('converts sheet purchase price and units; preserves manual override and supplier price', async () => {
    const rate = await record(materialRateSlot, 'sheet', {
      name: 'Example sheet',
      kind: 'material',
      group: 'board',
      unit: 'sheet',
      convert: 2,
      baseUnit: 'm2',
      price: money(100),
      basis: 'quote',
      source: 'example',
      quotedAt: '2026-01-01',
    });
    const input = line({
      components: [
        {
          key: 'panel',
          name: 'Panel',
          kind: 'material',
          basis: 'fixed',
          qtyPerUnit: 2,
          unit: 'm2',
          rateRef: assetRef(rate),
        },
      ],
    });
    const priced = priceLine(input, 'USD', new Map([[rate.id, rate]]), context());
    expect(priced.line.modelCostPerUnit).toEqual(money(100));
    input.components[0].override = { rate: money(30), reason: 'Example negotiated correction' };
    expect(
      priceLine(input, 'USD', new Map([[rate.id, rate]]), context()).line.modelCostPerUnit,
    ).toEqual(money(60));
  });
  it('missing rate, wrong units, unavailable FX and missing dimensions never yield invented model costs', async () => {
    for (const component of [
      { ...line().components[0], rate: undefined },
      { ...line().components[0], rate: money(10, 'EUR') },
      { ...line().components[0], basis: 'area' as const },
    ])
      expect(
        priceLine(line({ components: [component] }), 'USD', new Map(), context()).line
          .modelCostPerUnit,
      ).toBeNull();
    const rate = await record(materialRateSlot, 'bad-unit', {
      name: 'Example',
      kind: 'material',
      group: 'board',
      unit: 'kg',
      convert: 1,
      baseUnit: 'kg',
      price: money(10),
      basis: 'quote',
      source: 'example',
      quotedAt: '2026-01-01',
    });
    const c = { ...line().components[0], rate: undefined, rateRef: assetRef(rate) };
    expect(
      priceLine(line({ components: [c] }), 'USD', new Map([[rate.id, rate]]), context()).line
        .modelCostPerUnit,
    ).toBeNull();
    expect(convertUnit(1, 'kg', 'm2').value).toBeNull();
  });
  it('converts currency through injected FX and rounds each component', () => {
    const input = line({
      components: [{ ...line().components[0], qtyPerUnit: 3, rate: money(10, 'EUR') }],
    });
    expect(
      priceLine(input, 'USD', new Map(), context([], { 'fx.EUR.USD': 2 })).line.modelCostPerUnit,
    ).toEqual(money(60));
  });
  it.each(['table', 'cabinet', 'booth', 'curtain', 'rug'] as const)(
    '%s materializes editable components with one waste factor',
    (shape) => {
      const keys = [
        'top',
        'edge',
        'finish',
        'hardware',
        'shell',
        'shelf',
        'divider',
        'door',
        'back',
        'hinge',
        'handle',
        'frame',
        'panel',
        'cover',
        'foam',
        'cloth',
        'track',
        'accessory',
        'rug',
      ];
      const components: ComponentType[] = keys.map((key) => ({
        key,
        name: key,
        kind: 'material',
        basis: 'fixed',
        qtyPerUnit: 1,
        unit: 'm2',
        rate: money(10),
        rateNote: 'Synthetic',
      }));
      const result = generateComponents({
        shape,
        dimensionsMm: { l: 2000, w: 1000, h: 3000 },
        components,
        waste: 0.1,
        laborRate: money(10),
        minLabor: money(20),
        complexity: 2,
        geometry: {
          thicknessMm: 20,
          shelves: 1,
          dividers: 1,
          doors: 2,
          hingesPerDoor: 2,
          seatHeightMm: 1000,
          seatDepthMm: 500,
          frameVolumeM3: 0.1,
          referenceLengthMm: 1000,
          wrap: 2,
          seatFoamMm: 100,
          backFoamMm: 100,
          clothWidthMm: 4000,
          hemMm: 100,
          pleat: 2,
          mode: 'height',
        },
      });
      expect(result.components.every((c) => c.basis === 'fixed')).toBe(true);
      expect(result.components.find((c) => c.key === 'labor')?.rate?.amount).toBe(
        shape === 'cabinet' ? 416.8 : shape === 'curtain' ? 80 : 40,
      );
      if (shape === 'table')
        expect(result.components.find((c) => c.key === 'top')?.qtyPerUnit).toBeCloseTo(2.2);
      if (shape === 'rug')
        expect(result.components.find((c) => c.key === 'rug')?.qtyPerUnit).toBeCloseTo(2.2);
      if (shape === 'booth')
        expect(result.components.find((c) => c.key === 'frame')?.qtyPerUnit).toBeCloseTo(0.22);
      if (shape === 'curtain')
        expect(result.components.find((c) => c.key === 'cloth')?.qtyPerUnit).toBeCloseTo(4.4);
    },
  );
  it('curtain widths use complete panels and cabinet invalid geometry remains visible', () => {
    const components = ['cloth', 'track', 'accessory'].map((key) => ({
      ...line().components[0],
      key,
    }));
    const generated = generateComponents({
      shape: 'curtain',
      dimensionsMm: { l: 3000, w: 0, h: 2000 },
      geometry: { clothWidthMm: 2000, hemMm: 100, pleat: 2, mode: 'width' },
      components,
      waste: 0,
      laborRate: money(10),
      minLabor: money(0),
      complexity: 1,
    });
    expect(generated.components.find((c) => c.key === 'cloth')?.qtyPerUnit).toBeCloseTo(6.3);
  });
});
describe('quantity rules', () => {
  it.each([
    ['length', 11],
    ['area', 11],
    ['modules', 6],
    ['tiles', 6],
  ] as const)('%s quantity uses declared demand, loss and packaging', (kind, expected) => {
    const rule =
      kind === 'length' || kind === 'area'
        ? { kind, demand: 10, lossPct: 0.1 }
        : { kind, demand: 10, lossPct: 0.1, packSize: 2 };
    expect(
      resolveQuantities([line({ qtyRule: rule, dimensionsMm: { l: 2000, w: 1000, h: 100 } })]).get(
        'sample-line',
      ),
    ).toBe(expected);
  });
  it('site quantities change with actual area and linked quantities follow dependencies', () => {
    const first = line({ qtyRule: { kind: 'site', metric: 'area', factor: 0.1, lossPct: 0 } });
    const second = line({
      id: 'linked',
      qtyRule: { kind: 'linked', links: ['sample-line'], factor: 2 },
    });
    expect(resolveQuantities([first, second], { area: 101 }).get('linked')).toBe(22);
    expect(resolveQuantities([first, second], { area: 200 }).get('linked')).toBe(40);
  });
  it('rejects cycles, missing references, invalid dimensions, unavailable metrics and overflow', () => {
    expect(() =>
      resolveQuantities([line({ qtyRule: { kind: 'linked', links: ['sample-line'], factor: 1 } })]),
    ).toThrow(/cycle/);
    expect(() =>
      resolveQuantities([line({ qtyRule: { kind: 'linked', links: ['missing'], factor: 1 } })]),
    ).toThrow(/exist/);
    expect(() =>
      resolveQuantities([
        line({ qtyRule: { kind: 'modules', demand: 1, lossPct: 0, packSize: 1 } }),
      ]),
    ).toThrow(/dimensions/);
    expect(() =>
      resolveQuantities([
        line({ qtyRule: { kind: 'site', metric: 'seats', factor: 1, lossPct: 0 } }),
      ]),
    ).toThrow(/metric/);
    expect(() => resolveQuantities([line({ qty: 1e9 })])).toThrow(/100000000/);
  });
});
