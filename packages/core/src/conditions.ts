import { Measure, Unit, z } from './base.js';
import type { Need } from './step.js';
export const ConditionKey = z.enum([
  'area',
  'clearHeight',
  'floorLevel',
  'frontage',
  'zoningUse',
  'foodUse',
  'exhaustPath',
  'gasService',
  'gasCapacity',
  'powerCapacity',
  'serviceAmps',
  'serviceVoltage',
  'servicePhase',
  'waterService',
  'sewerSize',
  'greaseInterceptor',
  'coldStorageArea',
  'hvac',
  'loadingAccess',
  'parking',
  'ada',
]);
export type ConditionKey = z.infer<typeof ConditionKey>;
const Scalar = z.union([z.number(), z.string(), z.boolean()]);
export const Requirement = z.object({
  key: ConditionKey,
  op: z.enum(['gte', 'lte', 'eq', 'in', 'present']),
  value: z.union([Scalar, z.array(Scalar)]).optional(),
  unit: Unit.optional(),
  hard: z.boolean(),
});
export type Requirement = z.infer<typeof Requirement>;
export const ConditionReading = z.object({ key: ConditionKey, measure: Measure });
export type ConditionReading = z.infer<typeof ConditionReading>;
export const CONDITION_UNITS: Record<ConditionKey, readonly string[]> = {
  area: ['m2', 'ft2'],
  clearHeight: ['m', 'cm', 'mm', 'in', 'ft'],
  floorLevel: [],
  frontage: ['m', 'cm', 'mm', 'in', 'ft'],
  zoningUse: [],
  foodUse: [],
  exhaustPath: [],
  gasService: [],
  gasCapacity: ['m3/h', 'BTU/h'],
  powerCapacity: ['kW'],
  serviceAmps: ['A'],
  serviceVoltage: ['V'],
  servicePhase: [],
  waterService: [],
  sewerSize: ['m', 'cm', 'mm', 'in', 'ft'],
  greaseInterceptor: ['L', 'gal'],
  coldStorageArea: ['m2', 'ft2'],
  hvac: ['kW', 'BTU/h'],
  loadingAccess: [],
  parking: [],
  ada: [],
};
const FACTORS: Record<string, [string, number]> = {
  m: ['length', 1],
  cm: ['length', 0.01],
  mm: ['length', 0.001],
  in: ['length', 0.0254],
  ft: ['length', 0.3048],
  m2: ['area', 1],
  ft2: ['area', 0.09290304],
  kg: ['mass', 1],
  g: ['mass', 0.001],
  L: ['volume', 1],
  ml: ['volume', 0.001],
  gal: ['volume', 3.785411784],
  m3: ['volume', 1000],
  h: ['time', 1],
  day: ['time', 24],
  kW: ['power', 1],
  'BTU/h': ['power', 0.00029307107],
};
export function convertUnit(
  value: number,
  from: string,
  to: string,
): { value: number | null; needs: Need[] } {
  if (!Number.isFinite(value))
    return {
      value: null,
      needs: [
        { kind: 'input', path: 'measure.value', reason: 'Non-finite measure', blocking: true },
      ],
    };
  if (from === to) return { value, needs: [] };
  const a = FACTORS[from];
  const b = FACTORS[to];
  if (!a || !b || a[0] !== b[0])
    return {
      value: null,
      needs: [
        {
          kind: 'input',
          path: 'measure.unit',
          reason: `Cannot convert ${from} to ${to}`,
          blocking: true,
        },
      ],
    };
  return { value: (value * a[1]) / b[1], needs: [] };
}
export function convertMeasure(m: Measure, to: Unit): { value: Measure | null; needs: Need[] } {
  if (typeof m.value !== 'number' || !m.unit)
    return {
      value: null,
      needs: [
        {
          kind: 'input',
          path: 'measure.unit',
          reason: 'Numeric measure and unit required',
          blocking: true,
        },
      ],
    };
  const r = convertUnit(m.value, m.unit, to);
  return { value: r.value === null ? null : { ...m, value: r.value, unit: to }, needs: r.needs };
}
export function validateRequirement(r: Requirement): void {
  Requirement.parse(r);
  if (r.op !== 'present' && r.value === undefined) throw new Error('Requirement value missing');
  if (r.op === 'in' && (!Array.isArray(r.value) || !r.value.length))
    throw new Error('Requirement in requires values');
  if (['gte', 'lte'].includes(r.op) && typeof r.value !== 'number')
    throw new Error('Ordered requirement requires number');
  if (r.unit && !CONDITION_UNITS[r.key].includes(r.unit))
    throw new Error(`Invalid unit for ${r.key}`);
  if (r.key === 'exhaustPath' && r.op !== 'present') {
    const vs = Array.isArray(r.value) ? r.value : [r.value];
    if (vs.some((v) => !['existing', 'feasible', 'none'].includes(String(v))))
      throw new Error('Invalid exhaustPath');
  }
}
export function meets(
  req: Requirement,
  reading: ConditionReading | undefined,
): { value: boolean | null; needs: Need[] } {
  validateRequirement(req);
  if (!reading || reading.key !== req.key)
    return {
      value: null,
      needs: [{ kind: 'input', path: req.key, reason: 'Condition unmeasured', blocking: req.hard }],
    };
  if (req.op !== 'present' && CONDITION_UNITS[req.key].length > 0 && !req.unit) {
    return {
      value: null,
      needs: [
        {
          kind: 'input',
          path: `${req.key}.unit`,
          reason: 'Dimensional threshold requires an explicit unit',
          blocking: req.hard,
        },
      ],
    };
  }
  let v = reading.measure.value;
  if (req.unit) {
    if (typeof v !== 'number' || !reading.measure.unit)
      return {
        value: null,
        needs: [
          { kind: 'input', path: req.key, reason: 'Condition unit missing', blocking: req.hard },
        ],
      };
    const c = convertUnit(v, reading.measure.unit, req.unit);
    if (c.value === null) return { value: null, needs: c.needs };
    v = c.value;
  }
  return {
    value:
      req.op === 'present'
        ? true
        : req.op === 'eq'
          ? v === req.value
          : req.op === 'in'
            ? Array.isArray(req.value) && req.value.includes(v)
            : req.op === 'gte'
              ? typeof v === 'number' && v >= Number(req.value)
              : typeof v === 'number' && v <= Number(req.value),
    needs: [],
  };
}
