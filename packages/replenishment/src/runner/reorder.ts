import type { StepCtx, z } from '@osw/core';
import { blocked, inputNeeds } from '../helpers.js';
import { advanceReorder, draftReorder } from '../reorder.js';
import type { SupplyLedger } from './ports.js';

export async function persistDraftReorders(
  input: z.input<typeof draftReorder.input>,
  ctx: StepCtx,
  ledger: SupplyLedger,
) {
  const parsed = draftReorder.input.safeParse(input);
  if (!parsed.success)
    return blocked<z.infer<typeof draftReorder.output>>(inputNeeds(parsed.error));
  const step = await draftReorder.run(parsed.data, ctx);
  if (step.output)
    for (const entry of step.output.orders) await ledger.putReorder(entry.orderId, entry.order);
  return step;
}

export async function runReorderTransition(
  input: z.input<typeof advanceReorder.input>,
  ctx: StepCtx,
  ledger: SupplyLedger,
) {
  const parsed = advanceReorder.input.safeParse(input);
  if (!parsed.success)
    return blocked<z.infer<typeof advanceReorder.output>>(inputNeeds(parsed.error));
  const step = await advanceReorder.run(parsed.data, ctx);
  if (step.output)
    await ledger.putReorder(step.output.orderId, step.output.order, step.output.ifVersionHash);
  return step;
}
