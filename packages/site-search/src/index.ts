import type { WorkflowModule } from '@osw/core';
import { run } from './run.js';
import {
  competitorQuerySlot,
  listingSlot,
  placeObservationSlot,
  tradeAreaSlot,
} from './slots/index.js';
import { workflowSteps } from './workflow-steps.js';
export * from './contracts.js';
export * from './slots/index.js';
export * from './rules/rent.js';
export * from './rules/measure.js';
export * from './steps/screen.js';
export * from './steps/scan.js';
export * from './steps/selection.js';
export * from './steps/survey.js';
export * from './steps/legal.js';
export * from './steps/sign.js';
export { run, workflowSteps };
export const workflow: WorkflowModule = {
  key: 'site-search',
  version: '0.1.0',
  steps: workflowSteps,
  slots: [listingSlot, placeObservationSlot, competitorQuerySlot, tradeAreaSlot],
  run,
};

export type {
  SiteSearchProviders,
  PlacesProvider,
  ListingFeed,
  EsignProvider,
  GeocodeProvider,
} from './providers/types.js';
