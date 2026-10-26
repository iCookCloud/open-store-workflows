import { slotJsonSchema, z } from '@osw/core';
import { describe, expect, it } from 'vitest';
import {
  AcceptanceTemplate,
  BuildFee,
  InstallRate,
  PhaseTemplate,
  buildFeeSlot,
  installRateSlot,
  steps,
} from '../src/index.js';

describe('build-out slots and schemas', () => {
  it('accepts explicit zero-hour rates and rejects invalid quantities and empty match sets', () => {
    const rate = {
      match: {},
      priority: 0,
      hoursPerUnit: 0,
      unit: 'pcs',
      basis: 'No installation',
      source: 'estimate',
    };
    expect(InstallRate.parse(rate).hoursPerUnit).toBe(0);
    expect(InstallRate.safeParse({ ...rate, hoursPerUnit: -1 }).success).toBe(false);
    expect(InstallRate.safeParse({ ...rate, match: { category: [] } }).success).toBe(false);
    expect(InstallRate.safeParse({ ...rate, match: { nameContains: [10] } }).success).toBe(false);
  });
  it('requires the right fee operands and nonnegative rates', () => {
    const base = { name: 'Example fee', autoAdd: true, freight: false };
    expect(BuildFee.parse({ ...base, basis: 'pctOfGoods', pct: 0 }).pct).toBe(0);
    expect(
      BuildFee.parse({ ...base, basis: 'fixed', rate: { amount: 0, currency: 'USD' } }).rate
        ?.amount,
    ).toBe(0);
    expect(BuildFee.safeParse({ ...base, basis: 'perVolume' }).success).toBe(false);
    expect(
      BuildFee.safeParse({ ...base, basis: 'fixed', rate: { amount: -1, currency: 'USD' } })
        .success,
    ).toBe(false);
    expect(
      BuildFee.safeParse({ ...base, basis: 'fixed', pct: 10, rate: { amount: 1, currency: 'USD' } })
        .success,
    ).toBe(false);
  });
  it('exports input JSON schemas for slots, templates and all seven MCP steps', () => {
    for (const slot of [installRateSlot, buildFeeSlot])
      expect(slotJsonSchema(slot)).toHaveProperty('properties');
    for (const schema of [PhaseTemplate, AcceptanceTemplate, ...steps.map((s) => s.input)])
      expect(z.toJSONSchema(schema, { io: 'input' })).toHaveProperty('type', 'object');
    expect(PhaseTemplate.safeParse({ phases: [] }).success).toBe(false);
    expect(AcceptanceTemplate.safeParse({ items: [{ key: 'incomplete' }] }).success).toBe(false);
  });
});
