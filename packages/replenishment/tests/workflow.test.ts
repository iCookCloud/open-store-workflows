import { type Approval, type Need, type StepCtx, versionHash } from '@osw/core';
import { executeWorkflow, validateStepResult } from '@osw/core/node';
import { describe, expect, it, vi } from 'vitest';
import { replenishmentExample } from '../scripts/generate-examples.mjs';
import { approvalNeed } from '../src/helpers.js';
import { RunInput, SupplyProgram, run, steps, workflow } from '../src/run.js';
import { verifyUpstream } from '../src/verify.js';

function approvalsFor(needs: Need[], ctx: StepCtx): Approval[] {
  return needs.flatMap((need) =>
    need.kind === 'approval'
      ? [
          {
            step: need.step,
            subject: need.subject,
            subjectHash: need.subjectHash,
            decision: need.step === 'replenishment/selectAudience' ? 'send' : 'submit',
            ...(need.step === 'replenishment/advanceReorder' ? { role: 'store' } : {}),
            by: ctx.actor,
            at: ctx.now,
          },
        ]
      : [],
  );
}

describe('replenishment workflow integration', () => {
  it('does not credit orders after the menu observation window as opening-period evidence', async () => {
    const fixture = await replenishmentExample();
    const original = fixture.context.params;
    const ctx = {
      ...fixture.context,
      params: {
        ...original,
        get: (key: string) =>
          key === 'verify.menu.windowDays'
            ? { value: 5 }
            : key === 'verify.menu.minShare'
              ? { value: 0.4 }
              : original.get(key),
      },
    };
    const verified = await verifyUpstream.run(fixture.reorderInput.verification, ctx);
    expect(
      verified.verifications.find((entry) => entry.dimension === 'menuIngredients'),
    ).toMatchObject({ verdict: 'fails', measured: { actual: 0 } });
  });
  it('uses the latest actual approval instant when timestamps have different UTC offsets', async () => {
    const fixture = await replenishmentExample();
    const base = {
      step: 'replenishment/selectAudience',
      subject: 'campaign:example',
      subjectHash: '0'.repeat(64),
      by: 'example:reviewer',
    };
    const ctx = {
      ...fixture.context,
      approvals: [
        { ...base, at: '2026-02-02T10:00:00+02:00', decision: 'send' },
        { ...base, at: '2026-02-02T08:30:00Z', decision: 'deny' },
      ],
    };
    expect(approvalNeed(ctx, base.step, base.subject, base.subjectHash, 'send')).toMatchObject({
      kind: 'approval',
      blocking: true,
    });
  });
  it('hands opening stock to a campaign, gates approval, and emits a bounded private-data-free artifact', async () => {
    const fixture = await replenishmentExample();
    const before = fixture.context.assets.snapshot();
    const pending = await run(fixture.campaignInput, fixture.context);
    expect(pending.artifact).toBeNull();
    expect(pending.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', step: 'replenishment/selectAudience' }),
    );
    const approved = await run(fixture.campaignInput, {
      ...fixture.context,
      approvals: approvalsFor(pending.needs, fixture.context),
    });
    expect(approved.needs.filter((need) => need.blocking)).toEqual([]);
    const artifact = SupplyProgram.parse(approved.artifact);
    expect(artifact.hash).toBe(await versionHash(artifact.body));
    expect(artifact.inputs.map((ref) => ref.kind)).toEqual(['OpeningRecord', 'Bom']);
    expect(artifact.body.segmentation.total).toBe(2);
    expect(artifact.body.matches[0].segments[0].count).toBe(2);
    expect(artifact.body.campaigns[0].state).toBe('approved');
    expect(artifact.body.replenishShare).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ basis: 'none', stores: 1, byLines: null }),
        expect.objectContaining({ basis: 'bom', stores: 1, byLines: 1 }),
      ]),
    );
    expect(JSON.stringify(artifact)).not.toContain('@example.com');
    expect(
      artifact.sources.some((ref) => ['store-contact', 'send-log', 'reorder'].includes(ref.slot)),
    ).toBe(false);
    expect(fixture.context.assets.snapshot()).toEqual(before);
    for (const [id, output] of Object.entries(approved.steps))
      validateStepResult(steps.find((step) => step.id === id)!, output);
  });

  it('drafts and submits supplier orders only with store approval and keeps persisted summary separate', async () => {
    const fixture = await replenishmentExample();
    const pending = await run(fixture.reorderInput, fixture.context);
    const approvals = approvalsFor(pending.needs, fixture.context);
    expect(approvals).toHaveLength(1);
    const executed = await executeWorkflow(workflow, fixture.reorderInput, {
      source: fixture.context.assets,
      now: fixture.context.now,
      actor: fixture.context.actor,
      approvals,
    });
    expect(executed.exitCode).toBe(0);
    const transition = executed.result.steps['replenishment/advanceReorders'].output as {
      orders: { order: { state: string; lines: { unitPrice: unknown }[] } }[];
    };
    expect(transition.orders[0].order.state).toBe('submitted');
    expect(transition.orders[0].order.lines[0].unitPrice).toEqual({ amount: 20, currency: 'USD' });
    expect(SupplyProgram.parse(executed.result.artifact).body.reorders.byState).toEqual({
      delivered: 3,
    });
    expect(executed.result.steps['replenishment/verifyUpstream'].verifications).toContainEqual(
      expect.objectContaining({ dimension: 'menuIngredients', verdict: 'fails' }),
    );
  });

  it('blocks a changed upstream body and a mismatched reorder store before producing any artifact', async () => {
    const fixture = await replenishmentExample();
    const tampered = structuredClone(fixture.campaignInput);
    tampered.bom.body.lines[0].qty += 1;
    const rejected = await run(tampered, fixture.context);
    expect(rejected.artifact).toBeNull();
    expect(rejected.needs.some((need) => need.blocking)).toBe(true);
    const otherStore = await run(
      { ...fixture.reorderInput, storeId: 'example-supply-store-2' },
      fixture.context,
    );
    expect(otherStore.artifact).toBeNull();
    expect(otherStore.needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'storeId' }),
    );
  });

  it('preserves a paused campaign across a rerun and publishes the resume need', async () => {
    const fixture = await replenishmentExample();
    const first = await run(fixture.campaignInput, fixture.context);
    const ctx = { ...fixture.context, approvals: approvalsFor(first.needs, fixture.context) };
    const initial = await run(fixture.campaignInput, ctx);
    const previous = SupplyProgram.parse(initial.artifact).body.campaigns[0];
    const paused = await run(
      { ...fixture.campaignInput, previousCampaign: { ...previous, state: 'paused' } },
      ctx,
    );
    expect(SupplyProgram.parse(paused.artifact).body.campaigns[0].state).toBe('paused');
    expect(paused.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: `resume:${previous.campaignId}` }),
    );
  });

  it('reports schema errors as needs and propagates an asset-source outage', async () => {
    const fixture = await replenishmentExample();
    expect(RunInput.safeParse({ mode: 'reorder' }).success).toBe(false);
    expect(
      (await run({ mode: 'reorder' }, fixture.context)).needs.some((need) => need.kind === 'input'),
    ).toBe(true);
    vi.spyOn(fixture.context.assets, 'get').mockRejectedValue(new Error('Source unavailable'));
    await expect(run(fixture.campaignInput, fixture.context)).rejects.toThrow('Source unavailable');
  });
});
