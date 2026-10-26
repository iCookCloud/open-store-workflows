import { AssetId, AssetRef, Hash, IsoDateTime, SemVer, StepId, z } from '../base.js';
export const ArtifactKind = z.enum([
  'StoreSpec',
  'SiteDecision',
  'Bom',
  'DeliveryPlan',
  'BuildPlan',
  'OpeningRecord',
  'SupplyProgram',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;
export const ArtifactRef = z.object({ kind: ArtifactKind, id: z.string(), hash: Hash });
export type ArtifactRef = z.infer<typeof ArtifactRef>;
export const ArtifactEnvelope = <K extends ArtifactKind, B extends z.ZodType>(kind: K, body: B) =>
  z.object({
    kind: z.literal(kind),
    artifactVersion: SemVer,
    id: z.string().min(1).max(128),
    hash: Hash,
    producedBy: z.object({ step: StepId, pkg: z.string(), pkgVersion: SemVer }),
    storeId: AssetId.nullable(),
    inputs: z.array(ArtifactRef),
    sources: z.array(AssetRef),
    createdAt: IsoDateTime,
    example: z.literal(true).optional(),
    body,
  });
