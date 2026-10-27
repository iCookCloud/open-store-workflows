import { type Approval, MemorySource, SHARED_SLOTS, type StepCtx, versionHash } from '@osw/core';
import {
  approveBuildExample,
  buildContext,
  buildOutExample,
} from '../scripts/generate-examples.mjs';
import {
  type Bids,
  BuildOutInput,
  type Estimated,
  type Quoted,
  type Scheduled,
  type Takeoff,
  type Tracked,
  steps,
  workflow,
} from '../src/index.js';

export async function fixture() {
  const base = await buildOutExample();
  const input = BuildOutInput.parse(base.input);
  const records = base.records;
  const ctx: StepCtx = buildContext(records);
  const approved = await approveBuildExample(input, ctx);
  ctx.approvals = approved.approvals;
  return { input, records, ctx, approved: approved.result };
}
export function refreshSource(f: Awaited<ReturnType<typeof fixture>>) {
  f.ctx.assets = new MemorySource(f.records, [...SHARED_SLOTS, ...workflow.slots]);
}
export async function rehash(input: BuildOutInput) {
  input.bom.hash = await versionHash(input.bom.body);
  input.site.hash = await versionHash(input.site.body);
  input.delivery.inputs = [{ kind: 'Bom', id: input.bom.id, hash: input.bom.hash }];
  input.delivery.hash = await versionHash(input.delivery.body);
}
export function stages(f: Awaited<ReturnType<typeof fixture>>) {
  return structuredClone({
    takeoff: f.approved.steps['build-out/takeoff'].output as Takeoff,
    estimated: f.approved.steps['build-out/estimateHours'].output as Estimated,
    quoted: f.approved.steps['build-out/priceQuote'].output as Quoted,
    bids: f.approved.steps['build-out/levelBids'].output as Bids,
    scheduled: f.approved.steps['build-out/schedule'].output as Scheduled,
    tracked: f.approved.steps['build-out/track'].output as Tracked,
  });
}
export async function approveStep(
  index: number,
  input: unknown,
  ctx: StepCtx,
  role: string,
  decision: string,
  note?: string,
) {
  const step = steps[index];
  const pending = await step.run(input, ctx);
  const gate = pending.needs.find((n) => n.kind === 'approval');
  if (!gate || gate.kind !== 'approval') throw new Error(JSON.stringify(pending.needs));
  const consent: Approval = {
    step: step.id,
    subjectHash: gate.subjectHash,
    ...(gate.subject ? { subject: gate.subject } : {}),
    role,
    decision,
    by: `example:${role}`,
    at: ctx.now,
    ...(note ? { note } : {}),
  };
  return {
    consent,
    result: await step.run(input, { ...ctx, approvals: [...ctx.approvals, consent] }),
  };
}
