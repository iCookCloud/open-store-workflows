import { type StepDef, z } from '@osw/core';
import { inputNeed, parseInput, trainingResult } from './helpers.js';
import { ReadinessSummary, TrainingStatus } from './models.js';
const states = TrainingStatus.options;
export const TrainingTransitionInput = z.object({
  current: TrainingStatus,
  target: TrainingStatus,
  summary: ReadinessSummary,
});
export const TrainingTransitionOutput = z.object({ status: TrainingStatus });
export const trainingTransition: StepDef<
  typeof TrainingTransitionInput,
  typeof TrainingTransitionOutput
> = {
  id: 'opening/trainingTransition',
  input: TrainingTransitionInput,
  output: TrainingTransitionOutput,
  reads: [],
  params: [],
  async run(raw) {
    const parsed = parseInput(TrainingTransitionInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    if (Math.abs(states.indexOf(input.target) - states.indexOf(input.current)) > 1)
      return trainingResult(null, [
        inputNeed('target', 'Training can move only one phase at a time'),
      ]);
    if (input.target === 'certified' && !input.summary.ready)
      return trainingResult(null, [
        inputNeed('target', 'Training readiness is required for certification'),
      ]);
    return trainingResult({ status: input.target });
  },
};
