import { z } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { SiteDecision, run, workflow } from '../src/index.js';
import { sampleFlow } from './flow-fixtures.js';

describe('full site search workflow', () => {
  it('runs all ten steps on synthetic assets and produces a signed schema-valid decision', async () => {
    const f = await sampleFlow();
    expect(Object.keys(f.output.steps)).toHaveLength(10);
    expect(SiteDecision.parse(f.output.artifact).body.stage).toBe('signed');
    expect(f.output.steps.surveySite?.verifications).toContainEqual(
      expect.objectContaining({ verdict: 'fails' }),
    );
    expect(f.output.needs.filter((n) => n.blocking)).toEqual([]);
  });
  it('stops at signing when only signLease approval is missing', async () => {
    const f = await sampleFlow();
    const out = await run(
      f.plan,
      f.makeContext(f.approvals.filter((a) => a.step !== 'site-search/signLease')),
    );
    expect(out.steps.signLease?.output).toBeNull();
    expect(out.needs).toContainEqual(
      expect.objectContaining({ step: 'site-search/signLease', kind: 'approval', blocking: true }),
    );
    expect(out.artifact).toBeNull();
    expect(
      (out.steps.draftLoi?.output as { site: { body: { stage: string } } }).site.body.stage,
    ).toBe('loi');
  });
  it('prevents substituting a different listing between screening and assessment', async () => {
    const f = await sampleFlow();
    const plan = structuredClone(f.plan);
    plan.assessSite.listing = { ...plan.assessSite.listing!, id: 'foreign-listing' };
    const out = await run(plan, f.makeContext(f.approvals));
    expect(out.steps.assessSite?.output).toBeNull();
    expect(out.needs).toContainEqual(expect.objectContaining({ path: 'assessSite.listing' }));
    expect(out.steps.signLease).toBeUndefined();
  });
  it('rechecks unavailable premises and missing due diligence before signing', async () => {
    const f = await sampleFlow();
    for (const available of [false, true]) {
      const plan = structuredClone(f.plan);
      if (!available) plan.assessSite.availability.value = false;
      else plan.assessSite.dueDiligence = [];
      const out = await run(plan, f.makeContext(f.approvals));
      expect(out.artifact).toBeNull();
      expect(out.needs).toContainEqual(
        expect.objectContaining({ path: 'signLease.assessment', blocking: true }),
      );
    }
  });
  it('exports every step input and slot as JSON Schema without transforms', () => {
    for (const step of workflow.steps) expect(z.toJSONSchema(step.input)).toBeTruthy();
    for (const slot of workflow.slots) expect(z.toJSONSchema(slot.schema)).toBeTruthy();
  });
});
