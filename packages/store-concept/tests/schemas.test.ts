import { z } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { ConceptBrief } from '../src/brief.js';
import { CalcTemplate, calcTemplateSlot } from '../src/slots/calc-template.js';
import { SiteProfile } from '../src/slots/site-profile.js';
import { brief, template } from './fixtures.js';

describe('workflow asset contracts', () => {
  it('accepts a valid template and generates JSON Schema', () => {
    expect(CalcTemplate.parse(template()).currency).toBe('USD');
    expect(z.toJSONSchema(calcTemplateSlot.schema)).toHaveProperty('properties.params');
  });
  it.each(['seatRatio', 'turnover'] as const)('covers requires %s', (key) => {
    const value = template();
    delete value[key];
    expect(CalcTemplate.safeParse(value).success).toBe(false);
  });
  it('orders requires explicit daily order volume', () =>
    expect(CalcTemplate.safeParse({ ...template(), revenueModel: 'orders' }).success).toBe(false));
  it('rejects duplicate keys, invalid kind and missing scale base', () => {
    const value = template();
    value.params.push(value.params[0]!);
    expect(CalcTemplate.safeParse(value).success).toBe(false);
    expect(
      CalcTemplate.safeParse({
        ...template(),
        params: [{ ...template().params[0], baseAreaM2: null }],
      }).success,
    ).toBe(false);
    expect(
      CalcTemplate.safeParse({ ...template(), params: [{ ...template().params[0], key: 'rent' }] })
        .success,
    ).toBe(false);
  });
  it('rejects ambiguous subtotal cycles and monthly subtotal percentages', () => {
    const value = template();
    value.params.push({ ...value.params[2]!, key: 'consulting' });
    expect(CalcTemplate.safeParse(value).success).toBe(false);
    expect(
      CalcTemplate.safeParse({
        ...template(),
        params: [{ ...template().params[2], key: 'rent', kind: 'monthly' }],
      }).success,
    ).toBe(false);
  });
  it('requires timezone and a concept identity', () => {
    expect(ConceptBrief.safeParse({ ...brief, timezone: undefined }).success).toBe(false);
    expect(ConceptBrief.safeParse({ ...brief, timezone: 'not/a-zone' }).success).toBe(false);
    expect(
      ConceptBrief.safeParse({ ...brief, storeType: undefined, cuisine: undefined }).success,
    ).toBe(false);
  });
  it('rejects mixed currencies and invalid area requirement units', () => {
    expect(
      ConceptBrief.safeParse({
        ...brief,
        overrides: { equipment: { amount: 10, currency: 'EUR' } },
      }).success,
    ).toBe(false);
    expect(
      SiteProfile.safeParse({
        storeType: 'example',
        requirements: [
          { key: 'area', op: 'gte', value: 10, unit: 'kg', hard: true, reason: 'invalid' },
        ],
        equipmentTriggers: [],
      }).success,
    ).toBe(false);
  });
});
