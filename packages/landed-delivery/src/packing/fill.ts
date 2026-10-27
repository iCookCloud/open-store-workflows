import type { AssetRecordOf, FillSrc, Money, Product, z } from '@osw/core';
import type { DeliverySourceLine, PackingLine, Shipment } from '../models.js';
import type { PackingHistory } from '../slots.js';
import { classifyGoods } from './goods-class.js';
import { parseCartonUnits } from './units.js';

function cell<T>(value: T | undefined, src: z.infer<typeof FillSrc>) {
  return { value: value ?? null, src: value === undefined ? null : src };
}
export function packingLine(
  line: DeliverySourceLine,
  product: Product,
  qty: number,
  value: Money,
  histories: AssetRecordOf<z.infer<typeof PackingHistory>>[],
): PackingLine {
  const goods = classifyGoods(product, line.category, line.name);
  const cartonUnits =
    product.carton?.units ??
    parseCartonUnits(product.spec ?? line.spec) ??
    (goods.goodsClass === 'nonfood' ? 1 : undefined);
  const cartons = cartonUnits ? Math.ceil(qty / cartonUnits) : undefined;
  const net = product.netWeightKg ? product.netWeightKg * qty : undefined;
  const box = product.carton;
  const gross = box?.grossWeightKg && cartons ? box.grossWeightKg * cartons : net;
  const volume =
    box?.lMm && box.wMm && box.hMm && cartons
      ? ((box.lMm * box.wMm * box.hMm) / 1e9) * cartons
      : product.unitVolumeM3
        ? product.unitVolumeM3 * qty
        : product.dimensionsMm
          ? ((product.dimensionsMm.l * product.dimensionsMm.w * product.dimensionsMm.h) / 1e9) * qty
          : undefined;
  const history = [...histories].sort((a, b) =>
    a.data.confirmedAt < b.data.confirmedAt
      ? 1
      : a.data.confirmedAt > b.data.confirmedAt
        ? -1
        : a.id < b.id
          ? -1
          : 1,
  )[0]?.data;
  const material =
    product.customsMaterial ||
    product.materials?.map((item) => item.material).join(', ') ||
    undefined;
  return {
    id: line.id,
    bomLineId: line.id,
    lineKind: line.lineKind,
    productRef: line.productRef,
    offerRef: line.offerRef!,
    name: line.name,
    spec: line.spec,
    qty,
    goodsClass: goods.goodsClass,
    goodsClassSrc: goods.src,
    hsCode: cell(
      product.hsCode ?? history?.hsCode ?? undefined,
      product.hsCode ? 'asset' : 'history',
    ),
    materialText: cell(
      material ?? history?.materialText ?? undefined,
      material ? 'asset' : 'history',
    ),
    netWeightKg: cell(product.netWeightKg, 'asset'),
    cartonUnits: cell(cartonUnits, box?.units ? 'asset' : 'derived'),
    cartons: cell(cartons, 'derived'),
    totalNetWeightKg: cell(net, 'derived'),
    totalGrossWeightKg: cell(gross, 'derived'),
    totalVolumeM3: cell(volume, 'derived'),
    declaredValue: value,
  };
}
export const cellFields = [
  'hsCode',
  'materialText',
  'netWeightKg',
  'cartonUnits',
  'cartons',
  'totalNetWeightKg',
  'totalGrossWeightKg',
  'totalVolumeM3',
] as const;
export function fillEmptyCells(target: PackingLine, fresh: PackingLine) {
  for (const key of cellFields)
    if (target[key].value === null && target[key].src !== 'manual')
      Object.assign(target[key], fresh[key]);
}
export function gaps(shipment: Shipment): string[] {
  const missing: string[] = [];
  for (const key of ['jurisdiction', 'company', 'address', 'name', 'phone'] as const)
    if (!shipment.consignee[key]?.trim()) missing.push(`consignee.${key}`);
  if (shipment.crossBorder && shipment.carrier.kind !== 'seller') {
    if (!shipment.portTo) missing.push('portTo');
    for (const line of shipment.lines)
      for (const key of [
        'materialText',
        'hsCode',
        'cartons',
        'totalNetWeightKg',
        'totalGrossWeightKg',
        'totalVolumeM3',
      ] as const)
        if (line[key].value === null || line[key].value === '')
          missing.push(`lines.${line.id}.${key}`);
  }
  return missing;
}
export function conflicts(shipment: Shipment): string[] {
  const errors: string[] = [];
  if (!shipment.lines.length) errors.push('Shipment has no lines');
  if (new Set(shipment.lines.map((line) => line.id)).size !== shipment.lines.length)
    errors.push('Duplicate packing line IDs');
  for (const line of shipment.lines) {
    if (line.goodsClass !== shipment.goodsClass)
      errors.push(`${line.id}: goods class differs from shipment`);
    if (
      line.totalGrossWeightKg.value !== null &&
      line.totalNetWeightKg.value !== null &&
      line.totalGrossWeightKg.value < line.totalNetWeightKg.value
    )
      errors.push(`${line.id}: gross weight is below net weight`);
    if (line.hsCode.value && !/^\d{6,10}$/.test(line.hsCode.value.replace(/\s/g, '')))
      errors.push(`${line.id}: invalid HS code`);
    if (line.declaredValue.amount < 0) errors.push(`${line.id}: negative declared value`);
  }
  return errors;
}
