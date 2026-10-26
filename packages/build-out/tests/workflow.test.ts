import { type Approval, versionHash } from '@osw/core';
import { validateStepResult } from '@osw/core/node';
import { describe, expect, it, vi } from 'vitest';
import { BuildPlan, accept, changeSubject, run, steps, track } from '../src/index.js';
import { approveStep, fixture, stages } from './fixtures.js';

async function ownerDecision(
  state: ReturnType<typeof stages>['tracked'],
  f: Awaited<ReturnType<typeof fixture>>,
  decision = 'accept',
) {
  return approveStep(6, state, { ...f.ctx, approvals: [] }, 'owner', decision);
}

describe('tracking and signed changes', () => {
  it('keeps single-signed changes proposed and double-signed changes effective, without double applying on rerun', async () => {
    const f = await fixture();
    const state = stages(f).scheduled;
    const onlyOwner = f.ctx.approvals.filter((a) => a.step !== track.id || a.role === 'owner');
    const pending = await track.run(state, { ...f.ctx, approvals: onlyOwner });
    expect(pending.output?.changes[0].status).toBe('proposed');
    expect(pending.output?.quote.lines[0].qty).toBe(10);
    expect(pending.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', blocking: false }),
    );
    const first = await track.run(state, f.ctx);
    const second = await track.run(state, f.ctx);
    expect(second).toEqual(first);
    expect(first.output?.changes[0].status).toBe('effective');
    expect(first.output?.quote.lines[0].qty).toBe(20);
    expect(first.output?.quote.totals.total.amount).toBe(3820);
    expect(
      first.verifications.some((v) => v.dimension === 'hoursPerUnit' && v.verdict === 'fails'),
    ).toBe(true);
    expect(
      first.verifications.some((v) => v.dimension === 'hoursPerUnit' && v.verdict === 'holds'),
    ).toBe(true);
  });
  it('binds changes to the contractor identity, current quote and both distinct signers', async () => {
    const f = await fixture();
    const state = stages(f).scheduled;
    for (const mode of ['wrong-party', 'same-signer', 'future', 'stale-hash']) {
      const approvals = structuredClone(f.ctx.approvals) as Approval[];
      const owner = approvals.find((a) => a.step === track.id && a.role === 'owner')!;
      const contractor = approvals.find((a) => a.step === track.id && a.role === 'contractor')!;
      if (mode === 'wrong-party') contractor.party!.id = 'example-other-builder';
      if (mode === 'same-signer') contractor.by = owner.by;
      if (mode === 'future') contractor.at = '2030-01-01T00:00:00Z';
      if (mode === 'stale-hash') contractor.subjectHash = '0'.repeat(64);
      expect((await track.run(state, { ...f.ctx, approvals })).output?.changes[0].status).toBe(
        'proposed',
      );
    }
  });
  it('does not accept a signed but miscalculated price delta or negative quantity', async () => {
    const f = await fixture();
    const state = stages(f).scheduled;
    const change = state.input.changes[0];
    change.priceDelta.amount = 1;
    const hash = await versionHash(changeSubject(state.quote.quoteHash, change));
    const approvals = f.ctx.approvals.map((a) =>
      a.step === track.id ? { ...a, subjectHash: hash } : a,
    );
    const r = await track.run(state, { ...f.ctx, approvals });
    expect(r.output).toBeNull();
    expect(r.needs).toContainEqual(
      expect.objectContaining({ path: 'changes.example-extra-counter.priceDelta' }),
    );
  });
  it('requires predecessor completion and checkpoint evidence before downstream actual work', async () => {
    const f = await fixture();
    const state = stages(f).scheduled;
    state.input.actuals[2].start = '2026-01-07';
    expect((await track.run(state, f.ctx)).output).toBeNull();
    state.input.actuals[2].start = '2026-01-08';
    state.schedule.tasks[0].checkpoint = 'example-before-inspection';
    const r = await track.run(state, {
      ...f.ctx,
      approvals: f.ctx.approvals.filter((a) => a.step !== track.id),
    });
    expect(r.needs).toContainEqual(
      expect.objectContaining({ path: 'checkpoints.example-before-inspection' }),
    );
  });
});

describe('completion evidence', () => {
  it('requires the matching owner decision then emits accepted and conditional plans', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    const pending = await accept.run(state, { ...f.ctx, approvals: [] });
    expect(pending.output).toBeNull();
    expect(pending.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', blocking: true }),
    );
    const complete = await accept.run(state, f.ctx);
    expect(complete.output?.body.acceptance.status).toBe('accepted');
    expect(complete.output?.body.acceptance.acceptedAt).toBe(f.ctx.now);
    state.input.acceptance.punch.push({
      id: 'example-minor',
      title: 'Example minor touchup',
      severity: 'minor',
      owner: 'example:builder',
      due: '2026-02-10',
    });
    const conditional = await ownerDecision(state, f);
    expect(conditional.result.output.body.acceptance.status).toBe('conditional');
  });
  it('returns rejected on owner rejection and open when installed quantity or minor due date is missing', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    expect((await ownerDecision(state, f, 'reject')).result.output.body.acceptance.status).toBe(
      'rejected',
    );
    state.input.acceptance.installed = [];
    const open = await accept.run(state, { ...f.ctx, approvals: [] });
    expect(open.output?.body.acceptance.status).toBe('open');
    expect(open.output?.body.acceptance.lineChecks.every((l) => l.verdict === 'pending')).toBe(
      true,
    );
    state.input.acceptance.punch.push({
      id: 'example-minor',
      title: 'Example minor',
      owner: 'example:builder',
      severity: 'minor',
    });
    expect((await accept.run(state, f.ctx)).output?.body.acceptance.status).toBe('open');
  });
  it('fails damaged receipt checks and attributes the delivery discrepancy to the carrier', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    state.input.acceptance.observedDeliveries = [
      { lineId: 'example-appliance', receivedQty: 2, damagedQty: 1 },
    ];
    const r = await accept.run(state, f.ctx);
    expect(
      r.output?.body.acceptance.lineChecks.find((l) => l.lineId === 'example-appliance')?.verdict,
    ).toBe('fails');
    expect(r.output?.body.acceptance.status).toBe('open');
    expect(r.verifications).toContainEqual(
      expect.objectContaining({
        dimension: 'deliveredQty',
        verdict: 'fails',
        asset: expect.objectContaining({ id: 'example-delivery-party' }),
      }),
    );
  });
  it('does not treat an ETA as a received quantity', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    state.input.delivery.body.arrivals[0].receivedQty = null;
    const r = await accept.run(state, f.ctx);
    expect(r.output?.body.acceptance.lineChecks[0].verdict).toBe('pending');
    expect(r.output?.body.acceptance.status).toBe('open');
  });
  it('creates landlord blocking work and V7 failures even when the owner approves', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    state.input.acceptance.landlord[0].delivered = false;
    state.input.acceptance.possession!.observed = 'shell';
    const r = (await ownerDecision(state, f)).result;
    expect(r.output.body.acceptance.status).toBe('open');
    expect(
      r.output.body.acceptance.punch.filter((p: { owner: string }) => p.owner === 'landlord'),
    ).toHaveLength(2);
    expect(r.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'landlordWork', verdict: 'fails' }),
    );
    expect(r.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'deliveryCondition', verdict: 'fails' }),
    );
  });
  it('compares unchanged conditions independently of required minimum and converts units', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    state.input.acceptance.asBuilt[0].measure = { value: 120, unit: 'm2' };
    const r = (await ownerDecision(state, f)).result;
    expect(r.output?.body.acceptance.siteChecks[0].verdict).toBe('holds');
    expect(r.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'condition.area', verdict: 'fails' }),
    );
    state.input.acceptance.asBuilt[0].measure = { value: 100 / 0.09290304, unit: 'ft2' };
    const converted = await accept.run(state, f.ctx);
    expect(converted.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'condition.area', verdict: 'holds' }),
    );
  });
  it('requires fresh signatures for changed finish evidence, and attributes late completion to the contractor', async () => {
    const f = await fixture();
    const state = stages(f).tracked;
    state.input.acceptance.actualFinish = '2026-01-09';
    const r = await accept.run(state, f.ctx);
    expect(r.output).toBeNull();
    expect(r.needs).toContainEqual(expect.objectContaining({ kind: 'approval', blocking: true }));
    expect(r.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'finishDate', verdict: 'fails' }),
    );
  });
});

describe('workflow contract', () => {
  it('runs deterministically, preserves upstream references and performs no writes', async () => {
    const f = await fixture();
    const writes = vi.spyOn(f.ctx.assets as any, 'recordVerification');
    const first = await run(f.input, f.ctx);
    const second = await run(f.input, f.ctx);
    expect(second).toEqual(first);
    expect(writes).not.toHaveBeenCalled();
    for (const step of steps) validateStepResult(step, first.steps[step.id]);
    const artifact = BuildPlan.parse(first.artifact);
    expect(artifact.hash).toBe(await versionHash(artifact.body));
    expect(artifact.inputs.map((r) => r.kind)).toEqual(['SiteDecision', 'Bom', 'DeliveryPlan']);
    expect(artifact.body.quote.totals.total.amount).toBe(3820);
    expect(artifact.body.schedule.finish).toBe('2026-01-08');
    expect(artifact.body.acceptance.status).toBe('accepted');
  });
  it('stops at the first blocking gate and reports malformed workflow input as needs', async () => {
    const f = await fixture();
    const blocked = await run(f.input, { ...f.ctx, approvals: [] });
    expect(Object.keys(blocked.steps)).toEqual(['build-out/takeoff']);
    expect(blocked.artifact).toBeNull();
    const malformed = await run({}, f.ctx);
    expect(malformed.needs.every((n) => n.kind === 'input')).toBe(true);
    expect(malformed.artifact).toBeNull();
  });
});

describe('continuing an accepted build plan', () => {
  it('replays prior effective changes once when the last artifact is supplied', async () => {
    const f = await fixture();
    f.input.previousPlan = f.approved.artifact;
    const result = await run(f.input, f.ctx);
    expect(result.needs.filter((n) => n.blocking)).toEqual([]);
    expect(BuildPlan.parse(result.artifact).body.quote.totals.total.amount).toBe(3820);
    expect(BuildPlan.parse(result.artifact).body.quote.lines[0].qty).toBe(20);
    expect(BuildPlan.parse(result.artifact).hash).toBe(f.approved.artifact.hash);
  });
  it('refuses to silently remove or rewrite an effective change', async () => {
    const f = await fixture();
    f.input.previousPlan = f.approved.artifact;
    f.input.changes = [];
    const removed = await run(f.input, f.ctx);
    expect(removed.artifact).toBeNull();
    expect(removed.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'changes.example-extra-counter' }),
    );
  });
  it('cannot downgrade a previously effective change when its matching approvals are missing', async () => {
    const f = await fixture();
    f.input.previousPlan = f.approved.artifact;
    const result = await run(f.input, {
      ...f.ctx,
      approvals: f.ctx.approvals.filter((a) => a.step !== track.id),
    });
    expect(result.artifact).toBeNull();
    expect(result.needs).toContainEqual(
      expect.objectContaining({ step: track.id, blocking: true }),
    );
  });
});
