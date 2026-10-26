import type { Need, StepCtx, StepResult, WorkflowModule } from '@osw/core';
import { applyPartyEdits } from './policy.js';
import { slots } from './slots.js';
import { assignCarrier } from './steps/assign-carrier.js';
import { collectQuotes } from './steps/collect-quotes.js';
import { confirmPacking } from './steps/confirm-packing.js';
import { planShipments } from './steps/plan-shipments.js';
import { recordArrival } from './steps/record-arrival.js';
import { screenCompliance } from './steps/screen-compliance.js';
import { summarize } from './steps/summarize.js';
import { trackShipment } from './steps/track-shipment.js';

// 补格先于定稿，确保首次确认审批覆盖实际最终格值。
export const steps = [
  screenCompliance,
  planShipments,
  assignCarrier,
  applyPartyEdits,
  confirmPacking,
  collectQuotes,
  trackShipment,
  recordArrival,
  summarize,
] as const;
export async function run(input: unknown, ctx: StepCtx) {
  const results: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  let current = input;
  for (const step of steps) {
    const invoke = step.run as (input: unknown, ctx: StepCtx) => Promise<StepResult<unknown>>;
    const result = await invoke(current, ctx);
    results[step.id] = result;
    needs.push(...result.needs);
    if (result.output === null) return { steps: results, artifact: null, needs };
    current = result.output;
  }
  return { steps: results, artifact: current, needs };
}
export const workflow: WorkflowModule = {
  key: 'landed-delivery',
  version: '0.1.0',
  steps,
  slots,
  run,
};
