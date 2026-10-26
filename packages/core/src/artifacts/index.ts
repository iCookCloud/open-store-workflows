export * from './envelope.js';
export * from './store-spec.js';
export * from './site-decision.js';
export * from './bom.js';
export * from './delivery-plan.js';
export * from './build-plan.js';
export * from './opening-record.js';
export * from './supply-program.js';

import { BomBody } from './bom.js';
import { BuildPlanBody } from './build-plan.js';
import { DeliveryPlanBody } from './delivery-plan.js';
import { OpeningRecordBody } from './opening-record.js';
import { SiteDecisionBody } from './site-decision.js';
import { StoreSpecBody } from './store-spec.js';
import { SupplyProgramBody } from './supply-program.js';
export const ARTIFACTS = {
  StoreSpec: {
    producer: 'store-concept',
    consumers: ['site-search', 'fitout-bom', 'opening'],
    body: StoreSpecBody,
  },
  SiteDecision: {
    producer: 'site-search',
    consumers: ['fitout-bom', 'landed-delivery', 'build-out'],
    body: SiteDecisionBody,
  },
  Bom: {
    producer: 'fitout-bom',
    consumers: ['landed-delivery', 'build-out', 'replenishment'],
    body: BomBody,
  },
  DeliveryPlan: {
    producer: 'landed-delivery',
    consumers: ['build-out', 'opening'],
    body: DeliveryPlanBody,
  },
  BuildPlan: { producer: 'build-out', consumers: ['opening'], body: BuildPlanBody },
  OpeningRecord: { producer: 'opening', consumers: ['replenishment'], body: OpeningRecordBody },
  SupplyProgram: { producer: 'replenishment', consumers: [], body: SupplyProgramBody },
} as const;
