import { type Need, type StepCtx, createParamReader } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { StoreSpec } from '../src/steps/assemble-spec.js';
import { resolveConcept } from '../src/steps/resolve-concept.js';
import { shortlistMenus } from '../src/steps/shortlist-menus.js';
import { brief, fixture, now, record, template } from './fixtures.js';

const releaseNeed = (needs: Need[]) =>
  needs.find((need) => need.kind === 'approval' && need.step === 'store-concept/assembleSpec') as
    | Extract<Need, { kind: 'approval' }>
    | undefined;
async function menuApproved(ctx: StepCtx, hash: string): Promise<StepCtx> {
  return {
    ...ctx,
    approvals: [
      {
        step: 'store-concept/shortlistMenus',
        subject: 'menu:example-menu',
        subjectHash: hash,
        decision: 'approve',
        at: now,
        by: 'example:approver',
      },
    ],
  };
}
describe('store concept workflow', () => {
  it('blocks release without an approval, releases with the exact body hash, and invalidates on change', async () => {
    const { ctx, records } = await fixture({ stores: 3 });
    const approved = await menuApproved(ctx, records.find((r) => r.slot === 'menu')!.versionHash);
    const preview = await run(brief, approved);
    expect(preview.artifact).toBeNull();
    const need = releaseNeed(preview.needs)!;
    expect(need.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    const releasedCtx = {
      ...approved,
      approvals: [
        ...approved.approvals,
        {
          step: 'store-concept/assembleSpec',
          subjectHash: need.subjectHash,
          decision: 'release',
          at: now,
          by: 'example:approver',
        },
      ],
    };
    const released = await run(brief, releasedCtx);
    const artifact = StoreSpec.parse(released.artifact);
    expect(artifact.hash).toBe(need.subjectHash);
    expect(artifact.body.menu.status).toBe('approved');
    expect(artifact.body.economics.budgetRange.basis).toBe('actuals');
    expect(
      Object.values(released.steps)
        .flatMap((step) => step.verifications)
        .some((v) => v.verdict === 'fails'),
    ).toBe(true);
    expect(artifact.sources.some((ref) => ref.slot === 'store')).toBe(true);
    expect((await run({ ...brief, areaM2: 110 }, releasedCtx)).artifact).toBeNull();
  });
  it('returns input needs for absent timezone instead of guessing server time', async () => {
    const { ctx } = await fixture();
    const output = await run({ ...brief, timezone: undefined }, ctx);
    expect(output.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'timezone', blocking: true }),
    );
  });
  it('returns explicit asset need for zero matching templates and input need for ties', async () => {
    const { ctx, source } = await fixture();
    expect((await run({ ...brief, storeType: 'absent' }, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'asset', slot: 'calc-template' }),
    );
    source.add(await record('calc-template', 'tied-template', template()));
    expect((await run(brief, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'storeType' }),
    );
  });
  it('selects the longest applicable jurisdiction prefix', async () => {
    const { ctx, source } = await fixture();
    source.add(await record('calc-template', 'local-template', template(), ['XE-AA']));
    const selected = await resolveConcept.run({ ...brief, jurisdiction: 'XE-AA-BB' }, ctx);
    expect(selected.output?.template.id).toBe('local-template');
  });
  it('never carries menu approval across a changed asset hash', async () => {
    const { ctx, records, source } = await fixture();
    const approved = await menuApproved(ctx, records.find((r) => r.slot === 'menu')!.versionHash);
    const draft = (await resolveConcept.run(brief, approved)).output!;
    expect((await shortlistMenus.run(draft, approved)).output?.menu.status).toBe('approved');
    source.add(
      await record('menu', 'example-menu', {
        ...records.find((r) => r.slot === 'menu')!.data,
        pageCount: 3,
      }),
    );
    expect((await shortlistMenus.run(draft, approved)).output?.menu.status).toBe('candidate');
  });
  it('approved menus without derives remain unknown coldchain and create pending verification', async () => {
    const { ctx, records, source } = await fixture();
    const original = records.find((r) => r.slot === 'menu')!;
    const { derives: _derives, ...data } = original.data;
    const changed = await record('menu', original.id, data);
    source.add(changed);
    const approved = await menuApproved(ctx, changed.versionHash);
    const draft = (await resolveConcept.run(brief, approved)).output!;
    const result = await shortlistMenus.run(draft, approved);
    expect(result.output?.downstream.coldchain).toBeNull();
    expect(result.verifications[0]).toMatchObject({ verdict: 'pending', dimension: 'derives' });
  });
  it('nonfood skips menu and coldchain without needing cuisine', async () => {
    const { ctx } = await fixture({ template: { ...template(), nonFood: true, cuisines: [] } });
    const { cuisine: _cuisine, ...input } = brief;
    const draft = (await resolveConcept.run(input, ctx)).output!;
    const output = await shortlistMenus.run(draft, ctx);
    expect(output.output).toMatchObject({
      menu: { status: 'not-applicable' },
      downstream: { coldchain: false, ingredients: [] },
    });
  });
  it('missing defaults return per-key needs rather than misleading budgets', async () => {
    const { ctx } = await fixture({ template: { ...template(), hasDefaults: false } });
    const output = await run(brief, ctx);
    expect(output.steps['store-concept/estimate']?.output).toBeNull();
    expect(output.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'overrides.equipment' }),
    );
  });
  it('foreign-currency template converts once while target-currency override stays unchanged', async () => {
    const { ctx, source } = await fixture({ template: { ...template(), currency: 'EUR' } });
    source.add(await record('params', 'fx-example', { key: 'fx.EUR.USD', value: 2 }));
    const output = await run(
      { ...brief, overrides: { equipment: { amount: 90, currency: 'USD' } } },
      ctx,
    );
    const economics = (output.steps['store-concept/estimate']!.output as any).economics;
    expect(economics.investment.find((line: any) => line.key === 'equipment').amount.amount).toBe(
      90,
    );
    expect(economics.investment.find((line: any) => line.key === 'furnishing').amount.amount).toBe(
      2000,
    );
    expect(economics.spend).toEqual({ amount: 20, currency: 'USD' });
  });
  it('missing exchange rate is a blocking param need', async () => {
    const { ctx } = await fixture({ template: { ...template(), currency: 'EUR' } });
    const output = await run(brief, ctx);
    expect(output.needs).toContainEqual(
      expect.objectContaining({ kind: 'param', key: 'fx.EUR.USD', blocking: true }),
    );
  });
  it('sample shortage uses explicit band and a budget below the lower range blocks', async () => {
    const { ctx } = await fixture({ stores: 1 });
    const output = await run({ ...brief, budgetCap: { amount: 2000, currency: 'USD' } }, ctx);
    expect(output.needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'rescopeConcept' }),
    );
    const normal = await run(brief, ctx);
    expect((normal.steps['store-concept/calibrate']!.output as any).budgetRange).toEqual({
      low: { amount: 2640, currency: 'USD' },
      high: { amount: 3960, currency: 'USD' },
      basis: 'band',
      sampleSize: 1,
    });
  });
  it('same-source stores cannot validate the template they created and overrides are not verified', async () => {
    const t = template();
    for (const line of t.params) line.provenance.storeIds = ['example-store-0'];
    const { ctx } = await fixture({ template: t, stores: 2 });
    const output = await run(
      { ...brief, overrides: { equipment: { amount: 40, currency: 'USD' } } },
      ctx,
    );
    const calibration = output.steps['store-concept/calibrate']!;
    expect(calibration.verifications.some((v) => v.dimension === 'investment.equipment')).toBe(
      false,
    );
    expect(calibration.verifications).toHaveLength(2);
    expect(calibration.verifications.every((v) => v.reason.includes('example-store-1'))).toBe(true);
  });
  it('missing optional margin gives null rent ceiling and a nonblocking need', async () => {
    const { ctx, records } = await fixture();
    ctx.params = createParamReader(
      records.filter((r) => r.slot === 'params' && r.data.key !== 'concept.minMarginRate'),
      now,
    );
    const output = await run(brief, ctx);
    expect(
      (output.steps['store-concept/deriveSiteRequirements']!.output as any).rentCeiling,
    ).toBeNull();
    expect(output.needs).toContainEqual(
      expect.objectContaining({ kind: 'param', key: 'concept.minMarginRate', blocking: false }),
    );
  });
  it('rent ceiling follows margin and cannot override a user-specified rent', async () => {
    const { ctx } = await fixture();
    const output = await run(brief, ctx);
    expect(
      (output.steps['store-concept/deriveSiteRequirements']!.output as any).rentCeiling,
    ).toEqual({ amount: 3400, currency: 'USD' });
    const overridden = await run(
      { ...brief, overrides: { rent: { amount: 200, currency: 'USD' } } },
      ctx,
    );
    expect(
      (overridden.steps['store-concept/deriveSiteRequirements']!.output as any).rentCeiling,
    ).toBeNull();
  });
  it('paginates more than 200 same-type stores without dropping later actuals', async () => {
    const { ctx } = await fixture({ stores: 205 });
    const output = await run(brief, ctx);
    const calibration = output.steps['store-concept/calibrate']!;
    expect((calibration.output as any).budgetRange.sampleSize).toBe(205);
    expect(calibration.verifications).toHaveLength(615);
  });
  it('converts foreign actuals and normalizes only area-scaled budget lines', async () => {
    const { ctx, source } = await fixture({ stores: 2 });
    source.add(await record('params', 'fx-example', { key: 'fx.EUR.USD', value: 2 }));
    source.add(
      await record('store', 'example-store-0', {
        name: { en: 'Example store zero' },
        status: 'operating',
        track: 'example-noodle',
        storeType: 'example-noodle',
        jurisdiction: 'XE',
        timezone: 'UTC',
        areaM2: 50,
        actuals: [
          { key: 'equipment', amount: { amount: 500, currency: 'EUR' }, basis: 'paid', at: now },
          { key: 'furnishing', amount: { amount: 400, currency: 'EUR' }, basis: 'paid', at: now },
          {
            key: 'working_capital',
            amount: { amount: 100, currency: 'EUR' },
            basis: 'paid',
            at: now,
          },
        ],
      }),
    );
    const output = await run(brief, ctx);
    const verifications = output.steps['store-concept/calibrate']!.verifications;
    expect(
      verifications.find(
        (v) => v.reason.includes('example-store-0') && v.dimension === 'investment.equipment',
      )!.measured!.actual,
    ).toBe(2000);
    expect(
      verifications.find(
        (v) => v.reason.includes('example-store-0') && v.dimension === 'investment.furnishing',
      )!.measured!.actual,
    ).toBe(800);
  });
  it('mixed real and example input cannot label the result as wholly synthetic', async () => {
    const { ctx, source, records } = await fixture();
    const menu = records.find((record) => record.slot === 'menu')!;
    const { example: _example, ...unmarked } = menu;
    source.add(unmarked);
    const preview = await run(brief, ctx);
    const need = releaseNeed(preview.needs)!;
    const released = await run(brief, {
      ...ctx,
      approvals: [
        {
          step: 'store-concept/assembleSpec',
          subjectHash: need.subjectHash,
          decision: 'release',
          at: now,
          by: 'example:approver',
        },
      ],
    });
    expect(StoreSpec.parse(released.artifact).example).toBeUndefined();
  });
  it('future approvals are rejected using their actual timestamp across offsets', async () => {
    const { ctx, records } = await fixture();
    const draft = (await resolveConcept.run(brief, ctx)).output!;
    const output = await shortlistMenus.run(draft, {
      ...ctx,
      approvals: [
        {
          step: 'store-concept/shortlistMenus',
          subject: 'menu:example-menu',
          subjectHash: records.find((r) => r.slot === 'menu')!.versionHash,
          decision: 'approve',
          at: '2026-01-02T09:00:00-05:00',
          by: 'example:approver',
        },
      ],
    });
    expect(output.output!.menu.status).toBe('candidate');
  });
  it('records every fixed parameter asset with the exact scoped source hash', async () => {
    const { ctx, source, records } = await fixture();
    const scoped = await record('params', 'scoped-band', {
      key: 'concept.budgetBand',
      value: 0.1,
      appliesTo: { jurisdictions: ['XE'], tracks: ['example-noodle'] },
    });
    const irrelevant = await record('params', 'other-market-band', {
      key: 'concept.budgetBand',
      value: 0.8,
      appliesTo: { jurisdictions: ['XF'] },
    });
    source.add(scoped);
    source.add(irrelevant);
    ctx.params = createParamReader(
      [...records.filter((record) => record.slot === 'params'), scoped, irrelevant],
      now,
    );
    const preview = await run(brief, ctx);
    const need = releaseNeed(preview.needs)!;
    const released = StoreSpec.parse(
      (
        await run(brief, {
          ...ctx,
          approvals: [
            {
              step: 'store-concept/assembleSpec',
              subjectHash: need.subjectHash,
              decision: 'release',
              at: now,
              by: 'example:approver',
            },
          ],
        })
      ).artifact,
    );
    const sources = released.sources.filter((ref) => ref.slot === 'params');
    expect(sources).toHaveLength(5);
    expect(sources).toContainEqual({
      slot: 'params',
      id: scoped.id,
      versionHash: scoped.versionHash,
    });
    expect(sources.some((ref) => ref.id === 'concept.budgetBand' || ref.id === irrelevant.id)).toBe(
      false,
    );
    expect(released.body.economics.budgetRange.low.amount).toBe(2970);
    expect(released.example).toBe(true);
  });
  it('traces dynamically fetched FX parameters for both template and actuals with the selected scope', async () => {
    const { ctx, source } = await fixture({
      template: { ...template(), currency: 'EUR' },
      stores: 1,
    });
    const global = await record('params', 'fx-global', { key: 'fx.EUR.USD', value: 2 });
    const scoped = await record('params', 'fx-scoped', {
      key: 'fx.EUR.USD',
      value: 3,
      appliesTo: { jurisdictions: ['XE'], tracks: ['example-noodle'] },
    });
    const actualFx = await record('params', 'fx-actuals', { key: 'fx.GBP.USD', value: 4 });
    source.add(global);
    source.add(scoped);
    source.add(actualFx);
    source.add(
      await record('store', 'example-store-0', {
        name: { en: 'Example foreign actuals' },
        status: 'operating',
        track: 'example-noodle',
        storeType: 'example-noodle',
        jurisdiction: 'XE',
        timezone: 'UTC',
        areaM2: 100,
        actuals: [
          { key: 'equipment', amount: { amount: 1000, currency: 'GBP' }, basis: 'paid', at: now },
          { key: 'furnishing', amount: { amount: 500, currency: 'GBP' }, basis: 'paid', at: now },
          {
            key: 'working_capital',
            amount: { amount: 100, currency: 'GBP' },
            basis: 'paid',
            at: now,
          },
        ],
      }),
    );
    const preview = await run(brief, ctx);
    const need = releaseNeed(preview.needs)!;
    const released = StoreSpec.parse(
      (
        await run(brief, {
          ...ctx,
          approvals: [
            {
              step: 'store-concept/assembleSpec',
              subjectHash: need.subjectHash,
              decision: 'release',
              at: now,
              by: 'example:approver',
            },
          ],
        })
      ).artifact,
    );
    expect(released.sources).toContainEqual({
      slot: 'params',
      id: scoped.id,
      versionHash: scoped.versionHash,
    });
    expect(released.sources).toContainEqual({
      slot: 'params',
      id: actualFx.id,
      versionHash: actualFx.versionHash,
    });
    expect(released.sources.some((ref) => ref.id === global.id)).toBe(false);
    expect(released.body.economics.spend.amount).toBe(30);
    expect(released.example).toBe(true);
  });
  it('a real parameter asset prevents an otherwise synthetic artifact from carrying example true', async () => {
    const { ctx, source, records } = await fixture();
    const parameter = records.find((record) => record.id === 'concept.budgetBand')!;
    const { example: _example, ...realParameter } = parameter;
    source.add(realParameter);
    const preview = await run(brief, ctx);
    const need = releaseNeed(preview.needs)!;
    const released = StoreSpec.parse(
      (
        await run(brief, {
          ...ctx,
          approvals: [
            {
              step: 'store-concept/assembleSpec',
              subjectHash: need.subjectHash,
              decision: 'release',
              at: now,
              by: 'example:approver',
            },
          ],
        })
      ).artifact,
    );
    expect(released.example).toBeUndefined();
    expect(released.sources).toContainEqual({
      slot: 'params',
      id: parameter.id,
      versionHash: parameter.versionHash,
    });
  });
  it('unknown equipment trigger terms create fails verification and matched triggers become requirements', async () => {
    const { ctx, source } = await fixture();
    source.add(
      await record('site-profile', 'example-profile', {
        storeType: 'example-noodle',
        requirements: [],
        equipmentTriggers: [
          {
            termKeys: ['missing-term'],
            requirement: {
              key: 'powerCapacity',
              op: 'gte',
              value: 20,
              unit: 'kW',
              hard: true,
              reason: 'Example power',
            },
          },
          {
            termKeys: ['example-hood'],
            requirement: {
              key: 'exhaustPath',
              op: 'eq',
              value: 'existing',
              hard: true,
              reason: 'Example hood',
            },
          },
        ],
      }),
    );
    const output = await run(brief, ctx);
    const derived = output.steps['store-concept/deriveSiteRequirements']!;
    expect(derived.verifications).toContainEqual(expect.objectContaining({ verdict: 'fails' }));
    expect((derived.output as any).siteRequirements).toContainEqual(
      expect.objectContaining({ key: 'exhaustPath', value: 'existing', basis: 'menu' }),
    );
  });
});
