import {
  AssetRef,
  IsoDate,
  Jurisdiction,
  OpeningRecordBody,
  StoreSpecBody,
  TrackKey,
  z,
} from '@osw/core';
import { Cert } from '../slots/cert.js';
export const TrainingScope = z.object({ track: TrackKey, jurisdiction: Jurisdiction });
export const Seat = OpeningRecordBody.shape.certMatrix.shape.seats.element;
export const Cell = OpeningRecordBody.shape.certMatrix.shape.cells.element;
export const Staffing = OpeningRecordBody.shape.staffing;
export const StaffingPlan = StoreSpecBody.shape.staffing;
export const ReadinessSummary = OpeningRecordBody.shape.certMatrix.shape.summary;
export const PlanItem = Cert.extend({
  ref: AssetRef.optional(),
  enabled: z.boolean(),
  checks: z.array(z.string()),
  passScore: z.number().min(0).max(100).optional(),
});
export const PlanOutput = z.object({
  plan: AssetRef,
  items: z.array(PlanItem),
  sources: z.array(AssetRef),
});
export const TrainingStatus = z.enum(['planning', 'hiring', 'coaching', 'drilling', 'certified']);
export const TrainingDate = IsoDate;
export type TrainingScope = z.infer<typeof TrainingScope>;
export type Seat = z.infer<typeof Seat>;
export type Cell = z.infer<typeof Cell>;
export type PlanItem = z.infer<typeof PlanItem>;
export type Staffing = z.infer<typeof Staffing>;
