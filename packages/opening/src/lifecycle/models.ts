import {
  ArtifactEnvelope,
  BuildPlanBody,
  DeliveryPlanBody,
  OpeningRecordBody,
  StoreSpecBody,
  z,
} from '@osw/core';
export const StoreSpec = ArtifactEnvelope('StoreSpec', StoreSpecBody);
export const BuildPlan = ArtifactEnvelope('BuildPlan', BuildPlanBody);
export const DeliveryPlan = ArtifactEnvelope('DeliveryPlan', DeliveryPlanBody);
export const OpeningRecord = ArtifactEnvelope('OpeningRecord', OpeningRecordBody);
export const Checklist = OpeningRecordBody.shape.checklist;
export const Issue = OpeningRecordBody.shape.issues.element;
export const Cell = OpeningRecordBody.shape.certMatrix.shape.cells.element;
export const Matrix = OpeningRecordBody.shape.certMatrix;
export const CurrentRelease = OpeningRecordBody.shape.release.shape.current;
export const SignedRelease = OpeningRecordBody.shape.release.shape.signed;
export const OpeningStatus = OpeningRecordBody.shape.status;
export const Review = OpeningRecordBody.shape.reviews.element;
export const Timezone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone');
export const LIVE_STATUSES = new Set(['live', 'stabilizing', 'completed']);
export const artifactRef = (value: {
  kind: 'StoreSpec' | 'BuildPlan' | 'DeliveryPlan' | 'OpeningRecord';
  id: string;
  hash: string;
}) => ({ kind: value.kind, id: value.id, hash: value.hash });
