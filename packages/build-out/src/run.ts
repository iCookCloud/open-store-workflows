import type { Need, StepCtx, StepResult, WorkflowModule } from '@osw/core';
import { buildFeeSlot, installRateSlot } from './slots.js';
import { accept } from './steps/accept.js';
import { estimateHours } from './steps/estimate-hours.js';
import { levelBids } from './steps/level-bids.js';
import { priceQuote } from './steps/price-quote.js';
import { schedule } from './steps/schedule.js';
import { takeoff } from './steps/takeoff.js';
import { track } from './steps/track.js';

export const steps: WorkflowModule['steps'] = [
  takeoff,
  estimateHours,
  priceQuote,
  levelBids,
  schedule,
  track,
  accept,
];
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
  key: 'build-out',
  version: '0.1.0',
  steps,
  slots: [installRateSlot, buildFeeSlot],
  run,
};
