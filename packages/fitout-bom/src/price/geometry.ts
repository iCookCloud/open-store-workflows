import { type Component, type Money, roundMoney } from '@osw/core';

export interface GeometryInput {
  shape: 'table' | 'cabinet' | 'booth' | 'curtain' | 'rug' | 'components';
  dimensionsMm: { l: number; w: number; h: number };
  geometry: Record<string, number | string | boolean>;
  components: Component[];
  waste: number;
  laborRate: Money;
  minLabor: Money;
  complexity: number;
}
export interface GeometryResult {
  components: Component[];
  warnings: string[];
}

// 将几何量和损耗一次性固化为可编辑构件，定稿后无需依赖隐式默认值复算。
export function generateComponents(input: GeometryInput): GeometryResult {
  const { shape, geometry: g, dimensionsMm: d } = input;
  const L = d.l / 1000;
  const W = d.w / 1000;
  const H = d.h / 1000;
  if ([L, W, H, input.waste, input.complexity].some((v) => !Number.isFinite(v) || v < 0))
    throw new Error('Invalid geometry or pricing factors');
  if (input.laborRate.currency !== input.minLabor.currency)
    throw new Error('Labor currencies must match');
  const n = (key: string) => {
    const value = g[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`Missing or invalid geometry.${key}`);
    return value;
  };
  const positive = (key: string) => {
    const value = n(key);
    if (!value) throw new Error(`geometry.${key} must be positive`);
    return value;
  };
  const quantities: Record<string, number> = {};
  const warnings: string[] = [];
  let laborAmount = 0;
  if (shape === 'components')
    return {
      components: input.components.map((c) => ({
        ...c,
        qtyPerUnit: c.qtyPerUnit * (c.kind === 'material' ? 1 + input.waste : 1),
      })),
      warnings,
    };
  if (shape === 'table') {
    const top = input.components.find((c) => c.key === 'top');
    quantities.top = L * W * (top?.unit === 'm3' ? positive('thicknessMm') / 1000 : 1);
    quantities.edge = 2 * (L + W);
    quantities.finish = 2 * L * W;
    quantities.hardware = 1;
    laborAmount = L * W;
  } else if (shape === 'cabinet') {
    const t = positive('thicknessMm') / 1000;
    const iw = L - 2 * t;
    const ih = H - 2 * t;
    if (iw <= 0 || ih <= 0)
      warnings.push('Cabinet dimensions must exceed twice the panel thickness');
    const a = Math.max(0, iw);
    const b = Math.max(0, ih);
    const s = n('shelves');
    const v = n('dividers');
    const doors = n('doors');
    quantities.shell = 2 * a * W + 2 * H * W;
    quantities.shelf = s * a * W;
    quantities.divider = v * b * W;
    quantities.door = doors > 0 ? L * H : 0;
    quantities.back = L * H;
    quantities.edge = 2 * a + 2 * H + s * a + v * b + (doors > 0 ? 2 * (L + doors * H) : 0);
    quantities.hinge = doors * n('hingesPerDoor');
    quantities.handle = doors;
    quantities.hardware = 1;
    laborAmount = quantities.shell + quantities.shelf + quantities.divider + quantities.door;
    quantities.finish = 2 * laborAmount;
  } else if (shape === 'booth') {
    const sh = n('seatHeightMm') / 1000;
    const sd = n('seatDepthMm') / 1000;
    const bh = Math.max(0, H - sh);
    if (H <= sh) warnings.push('Total height must exceed seat height');
    if (sd > W) warnings.push('Seat depth exceeds total depth');
    quantities.frame = (n('frameVolumeM3') * L) / (positive('referenceLengthMm') / 1000);
    quantities.panel = L * sd + L * bh + 2 * W * sh;
    quantities.cover = L * (sd + bh) * n('wrap');
    quantities.foam = L * ((sd * n('seatFoamMm')) / 1000 + (bh * n('backFoamMm')) / 1000);
    quantities.hardware = 1;
    laborAmount = L;
  } else if (shape === 'curtain') {
    const width = positive('clothWidthMm') / 1000;
    const cutH = H + n('hemMm') / 1000;
    const pleat = positive('pleat');
    if (g.mode !== 'height' && g.mode !== 'width')
      throw new Error('geometry.mode must be height or width');
    quantities.cloth =
      g.mode === 'height' ? L * pleat : Math.ceil((L * pleat) / width - 1e-10) * cutH;
    if (g.mode === 'height' && cutH > width)
      warnings.push('Cloth width is insufficient for curtain height');
    quantities.track = L;
    quantities.accessory = L * pleat;
    laborAmount = L * pleat;
  } else {
    quantities.rug = L * W;
    quantities.edge = 2 * (L + W);
    laborAmount = L * W;
  }
  const components: Component[] = Object.entries(quantities).map(([key, qty]) => {
    const original = input.components.find((c) => c.key === key);
    if (!original) throw new Error(`Template requires component ${key}`);
    return {
      ...original,
      basis: 'fixed',
      qtyPerUnit: qty * (original.kind === 'material' ? 1 + input.waste : 1),
    };
  });
  const labor = roundMoney({
    amount:
      Math.max(input.minLabor.amount, laborAmount * input.laborRate.amount) * input.complexity,
    currency: input.laborRate.currency,
  });
  components.push({
    key: 'labor',
    name: '加工人工',
    kind: 'labor',
    basis: 'fixed',
    qtyPerUnit: 1,
    unit: 'lot',
    rate: labor,
    rateNote: `max(${input.minLabor.amount}, ${laborAmount} × ${input.laborRate.amount}) × ${input.complexity}`,
  });
  return { components, warnings };
}
