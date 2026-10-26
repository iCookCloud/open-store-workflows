import {
  type AssetRecordOf,
  type BomLine,
  type Money,
  type Need,
  type StepCtx,
  convertMoney,
  convertUnit,
  roundMoney,
} from '@osw/core';
import { assertVersion, inputNeed } from '../helpers.js';
import type { MaterialRate } from '../schema.js';

// 汇率不推倒数、不猜默认值；调用方收集缺项，模型成本保持 null。
export function moneyIn(
  money: Money,
  currency: string,
  ctx: StepCtx,
  needs: Need[],
  blocking = false,
): Money | null {
  const converted = convertMoney(money, currency, ctx.params);
  needs.push(...converted.needs.map((n) => ({ ...n, blocking })));
  return converted.value;
}
export function priceLine(
  original: BomLine,
  currency: string,
  rates: ReadonlyMap<string, AssetRecordOf<MaterialRate>>,
  ctx: StepCtx,
): { line: BomLine; needs: Need[] } {
  const line = structuredClone(original);
  const needs: Need[] = [];
  line.parts = [];
  line.modelWarnings = [];
  let complete = true;
  if (line.pricingMode === 'whole') {
    line.modelCostPerUnit = line.wholeEstimate
      ? moneyIn(line.wholeEstimate.unit, currency, ctx, needs)
      : null;
    if (!line.modelCostPerUnit)
      line.modelWarnings.push('Whole-item estimate is missing or cannot be converted');
  } else {
    const d = line.dimensionsMm;
    const L = (d?.l ?? 0) / 1000;
    const W = (d?.w ?? 0) / 1000;
    const H = (d?.h ?? 0) / 1000;
    const measures = {
      fixed: 1,
      length: L,
      area: L * W,
      front: L * H,
      side: W * H,
      volume: L * W * H,
      skin: 2 * (L * W + L * H + W * H),
      cylinder: Math.PI * L * H,
    };
    for (const c of line.components) {
      if (c.basis !== 'fixed' && !d) {
        needs.push(
          inputNeed(`lines.${line.id}.dimensionsMm`, 'Dimensions required by component', false),
        );
        complete = false;
        continue;
      }
      let rate = c.override?.rate ?? c.rate;
      if (c.rateRef) {
        const record = rates.get(c.rateRef.id);
        if (!assertVersion(record, c.rateRef, needs)) {
          complete = false;
          continue;
        }
        if (record) {
          const r = record.data;
          if (!c.override) {
            // 将一个组件单位换算成基准单位；价格单位不匹配时禁止直接相乘。
            const units = convertUnit(1, c.unit, r.baseUnit);
            if (units.value === null) {
              needs.push(
                inputNeed(
                  `lines.${line.id}.components.${c.key}.unit`,
                  'Material and component units are incompatible',
                  false,
                ),
              );
              complete = false;
              continue;
            }
            rate = {
              amount: (r.price.amount / r.convert) * units.value,
              currency: r.price.currency,
            };
          }
          if (r.sheet && d) {
            if (d.l > Math.max(r.sheet.l, r.sheet.w) || d.w > Math.min(r.sheet.l, r.sheet.w))
              line.modelWarnings.push(
                `${c.name}: panel exceeds stock sheet dimensions; joining required`,
              );
            if (line.spec.includes('thickness:')) {
              const match = /thickness:\s*([\d.]+)/.exec(line.spec);
              if (match && Number(match[1]) !== r.sheet.t)
                line.modelWarnings.push(
                  `${c.name}: thickness differs from quoted sheet; obtain a new rate`,
                );
            }
          }
        }
      }
      if (!rate) {
        complete = false;
        line.modelWarnings.push(`${c.name}: missing rate`);
        continue;
      }
      const converted = moneyIn(rate, currency, ctx, needs);
      if (!converted) {
        complete = false;
        continue;
      }
      const qty = c.qtyPerUnit * measures[c.basis];
      line.parts.push({
        key: c.key,
        name: c.name,
        kind: c.kind,
        qty,
        unit: c.unit,
        rate: converted,
        total: roundMoney({ amount: qty * converted.amount, currency }),
        note: c.override?.reason ?? c.rateNote ?? 'Referenced material rate',
      });
    }
    line.modelCostPerUnit = complete
      ? roundMoney({ amount: line.parts.reduce((sum, p) => sum + p.total.amount, 0), currency })
      : null;
  }
  if (line.costBasis === 'model' && line.modelCostPerUnit)
    line.unitPrice = {
      ...line.modelCostPerUnit,
      basis: line.pricingMode === 'custom' ? 'model' : (line.wholeEstimate?.basis ?? 'estimate'),
    };
  return { line, needs };
}
