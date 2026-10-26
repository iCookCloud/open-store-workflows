import { AssetRecord, AssetRef, Money, StoreSpecBody, z } from '@osw/core';
import { ConceptBrief } from './brief.js';
import { EngineOutput } from './engine.js';
import { CalcTemplate } from './slots/calc-template.js';
import { SiteProfile } from './slots/site-profile.js';

export const ConceptDraft = z.object({
  brief: ConceptBrief,
  template: AssetRecord(CalcTemplate),
  profile: AssetRecord(SiteProfile),
});
export type ConceptDraft = z.infer<typeof ConceptDraft>;
export const MenuSelection = z.object({
  concept: ConceptDraft,
  menu: StoreSpecBody.shape.menu,
  downstream: StoreSpecBody.shape.downstream,
  sources: z.array(AssetRef),
  example: z.boolean(),
});
export type MenuSelection = z.infer<typeof MenuSelection>;
export const EstimatedConcept = z.object({
  selection: MenuSelection,
  economics: EngineOutput,
  sources: z.array(AssetRef),
  example: z.boolean(),
});
export type EstimatedConcept = z.infer<typeof EstimatedConcept>;
export const Calibration = z.object({
  estimate: EstimatedConcept,
  investment: StoreSpecBody.shape.economics.shape.investment,
  budgetRange: StoreSpecBody.shape.economics.shape.budgetRange,
  sources: z.array(AssetRef),
  example: z.boolean(),
});
export type Calibration = z.infer<typeof Calibration>;
export const SiteRequirements = z.object({
  calibration: Calibration,
  siteRequirements: StoreSpecBody.shape.siteRequirements,
  area: StoreSpecBody.shape.area,
  rentCeiling: Money.nullable(),
  sources: z.array(AssetRef),
  example: z.boolean(),
});
export type SiteRequirements = z.infer<typeof SiteRequirements>;
