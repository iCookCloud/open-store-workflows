import { type StepCtx, convertUnit, validateFilter } from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import { assessRent, monthlyRent } from '../src/rules/rent.js';
import { Listing, TradeArea, deriveListingId, listingSlot } from '../src/slots/index.js';
import { compareCandidates, screenListings, screeningFilter } from '../src/steps/screen.js';
import { surveySite } from '../src/steps/survey.js';
import { context, defaults, listingData, observed, record, spec } from './fixtures.js';

describe('listing and screening contracts', () => {
  it('rejects placeholder areas, reversed intervals and missing per-area units', () => {
    expect(Listing.safeParse(listingData({ area: { min: 1, max: 1, unit: 'ft2' } })).success).toBe(
      false,
    );
    expect(
      Listing.safeParse(listingData({ area: { min: 100, max: 50, unit: 'm2' } })).success,
    ).toBe(false);
    expect(
      Listing.safeParse(
        listingData({
          askingRent: { base: { amount: 30, currency: 'USD' }, period: 'year', basis: 'per_area' },
        }),
      ).success,
    ).toBe(false);
  });
  it('derives stable source identities and deterministic collision suffixes', async () => {
    const source = listingData().source;
    expect(await deriveListingId(source)).toBe(
      await deriveListingId({ ...source, url: 'https://example.com/new-url' }),
    );
    expect(await deriveListingId(source, 'unit-a')).not.toBe(
      await deriveListingId(source, 'unit-b'),
    );
    await expect(deriveListingId({ ...source, url: null, sourceListingId: null })).rejects.toThrow(
      'stable',
    );
  });
  it('pushes unit-aware overlap and excludes out-of-area, wrong-jurisdiction and prohibited listings', async () => {
    const records = await Promise.all([
      record('listing', 'metric', listingData()),
      record('listing', 'imperial', listingData({ area: { min: 1000, max: 1200, unit: 'ft2' } })),
      record('listing', 'boundary', listingData({ area: { min: 120, max: 140, unit: 'm2' } })),
      record('listing', 'small', listingData({ area: { min: 50, max: 60, unit: 'm2' } })),
      record('listing', 'wrong-j', listingData({ jurisdiction: 'XF' })),
      record('listing', 'prohibited', listingData({ foodUse: 'prohibited' })),
    ]);
    const ctx = context(records);
    const spy = vi.spyOn(ctx.assets, 'query');
    const out = await screenListings({ spec, center: { lat: 0, lng: 0 } }, ctx);
    expect(out.output?.pending.map((r) => r.listing.id).sort()).toEqual([
      'boundary',
      'imperial',
      'metric',
    ]);
    const filter = spy.mock.calls.find((c) => c[0].name === 'listing')![1];
    expect(() => validateFilter(listingSlot, filter)).not.toThrow();
    expect(JSON.stringify(filter)).toContain('area.unit');
    expect(out.verifications).toEqual([]);
  });
  it('missing required parameters blocks without guessing', async () => {
    const out = await screenListings(
      { spec, center: { lat: 0, lng: 0 } },
      context([], { params: {} }),
    );
    expect(out.output).toBeNull();
    expect(out.needs.filter((n) => n.kind === 'param')).toHaveLength(2);
  });
  it('unknown use, missing price, expired reads remain pending', async () => {
    const item = await record(
      'listing',
      'unknown',
      listingData({ foodUse: 'unknown', askingRent: null, expiresAt: '2020-01-01' }),
    );
    const out = await screenListings({ spec, center: { lat: 0, lng: 0 } }, context([item]));
    expect(out.output?.passed).toEqual([]);
    expect(out.output?.pending[0]?.checks.find((c) => c.key === 'status')?.verdict).toBe('pending');
  });
  it('paginates beyond the source page cap without whole-library fetch', async () => {
    const rows = await Promise.all(
      Array.from({ length: 205 }, (_, i) => record('listing', `example-${i}`, listingData())),
    );
    const ctx = context(rows, { params: { ...defaults, 'site.screenLimit': 203 } });
    const spy = vi.spyOn(ctx.assets, 'query');
    const out = await screenListings({ spec, center: { lat: 0, lng: 0 } }, ctx);
    expect(out.output?.pending).toHaveLength(203);
    const calls = spy.mock.calls.filter((c) => c[0].name === 'listing');
    expect(calls.map((c) => c[2]?.limit)).toEqual([200, 3]);
    expect(calls[1]?.[2]?.cursor).toBeTruthy();
  });
  it('normalizes annual area rent, charges, and FX without default rates', () => {
    const rent = {
      base: { amount: 30, currency: 'USD' },
      period: 'year' as const,
      basis: 'per_area' as const,
      areaUnit: 'ft2' as const,
    };
    expect(monthlyRent(rent, 100).amount).toBe(2690.98);
    const unknown = assessRent(listingData({ additionalRent: 'nnn' }), spec, context());
    expect(unknown.monthlyTotal).toBeNull();
    const missingFx = assessRent(
      listingData({ askingRent: { ...rent, base: { amount: 30, currency: 'EUR' } } }),
      spec,
      context(),
    );
    expect(missingFx.needs).toContainEqual(expect.objectContaining({ key: 'fx.EUR.USD' }));
  });
  it('requires numeric population and a real spatial coverage definition', () => {
    expect(
      TradeArea.safeParse({
        jurisdiction: 'XE',
        residents: observed(10000),
        method: 'exact',
        period: '2026',
      }).success,
    ).toBe(false);
  });
});

describe('survey truth versus fit', () => {
  it('records 12 ft claimed versus 10.5 ft observed as a -1.5 ft failure', async () => {
    const listing = await record('listing', 'one', listingData());
    const output = await surveySite(
      {
        listing,
        requirements: spec.siteRequirements,
        readings: [{ key: 'clearHeight', measure: observed(10.5, 'ft') }],
      },
      context([listing]),
    );
    expect(output.output?.conditions[0]?.verdict).toBe('holds');
    expect(output.verifications[0]).toMatchObject({
      verdict: 'fails',
      measured: { delta: -1.5, expected: 12, actual: 10.5, unit: 'ft' },
    });
  });
  it('converts evidence units and refuses self-confirmation', async () => {
    const listing = await record('listing', 'one', listingData());
    const measure = observed(3.6576, 'm');
    const out = await surveySite(
      { listing, requirements: [], readings: [{ key: 'clearHeight', measure }] },
      context([listing]),
    );
    expect(out.verifications[0]?.verdict).toBe('holds');
    measure.refs = listing.data.refs;
    const same = await surveySite(
      { listing, requirements: [], readings: [{ key: 'clearHeight', measure }] },
      context([listing]),
    );
    expect(same.verifications[0]?.verdict).toBe('pending');
  });
  it('rejects estimated or future survey evidence', async () => {
    const listing = await record('listing', 'one', listingData());
    for (const measure of [
      { ...observed(10, 'ft'), basis: 'estimate' as const },
      { ...observed(10, 'ft'), at: '2030-01-01T00:00:00Z' },
    ]) {
      const out = await surveySite(
        { listing, requirements: [], readings: [{ key: 'clearHeight', measure }] },
        context(),
      );
      expect(out.output).toBeNull();
    }
  });
});
