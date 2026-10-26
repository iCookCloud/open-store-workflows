import type { Need, StepCtx, StepResult, WorkflowModule } from '@osw/core';
import { calcTemplateSlot } from './slots/calc-template.js';
import { siteProfileSlot } from './slots/site-profile.js';
import { assembleSpec } from './steps/assemble-spec.js';
import { calibrate } from './steps/calibrate.js';
import { estimate } from './steps/estimate.js';
import { resolveConcept } from './steps/resolve-concept.js';
import { shortlistMenus } from './steps/shortlist-menus.js';
import { deriveSiteRequirements } from './steps/site-requirements.js';

export const steps = [
  resolveConcept,
  shortlistMenus,
  estimate,
  calibrate,
  deriveSiteRequirements,
  assembleSpec,
] as const;
export async function run(input: unknown, ctx: StepCtx) {
  const results: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  let current: unknown = input;
  for (const step of steps) {
    const invoke = step.run as (input: unknown, ctx: StepCtx) => Promise<StepResult<unknown>>;
    const output = await invoke(current, ctx);
    results[step.id] = output;
    needs.push(...output.needs);
    if (output.output === null) return { steps: results, artifact: null, needs };
    current = output.output;
  }
  return { steps: results, artifact: current, needs };
}
export const workflow: WorkflowModule = {
  key: 'store-concept',
  version: '0.1.0',
  steps,
  slots: [calcTemplateSlot, siteProfileSlot],
  run,
};
