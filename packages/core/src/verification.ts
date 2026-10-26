import { AssetRef, Hash, IsoDate, IsoDateTime, StepId, z } from './base.js';
export const Verification = z.object({
  asset: AssetRef,
  purpose: StepId,
  verdict: z.enum(['holds', 'fails', 'pending']),
  reason: z.string().min(1).max(500),
  dimension: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_.]{0,63}$/)
    .optional(),
  measured: z
    .object({
      field: z.string(),
      expected: z.union([z.number(), z.string()]).nullable(),
      actual: z.union([z.number(), z.string()]),
      unit: z.string().optional(),
      delta: z.number().optional(),
    })
    .optional(),
  evidence: z.array(z.string().max(512)).max(20).optional(),
  at: IsoDateTime,
  by: z.string().min(1).max(128),
});
export type Verification = z.infer<typeof Verification>;
export const Approval = z.object({
  step: StepId,
  subject: z.string().max(200).optional(),
  subjectHash: Hash,
  decision: z.string().min(1).max(200),
  by: z.string().min(1).max(128),
  role: z.string().optional(),
  party: AssetRef.optional(),
  conditions: z.array(z.object({ ref: z.string(), text: z.string(), dueDate: IsoDate })).optional(),
  at: IsoDateTime,
  note: z.string().max(2000).optional(),
});
export type Approval = z.infer<typeof Approval>;
export const Fill = z.object({
  asset: AssetRef,
  field: z.string(),
  value: z.unknown(),
  by: z.string(),
  at: IsoDateTime,
});
export type Fill = z.infer<typeof Fill>;
export type RecordResult =
  | { status: 'recorded' | 'duplicate' }
  | {
      status: 'source_changed' | 'not_found' | 'not_empty' | 'rejected' | 'unsupported';
      detail?: string;
    };
export function verificationKey(v: Verification): string {
  return JSON.stringify([
    v.asset.slot,
    v.asset.id,
    v.asset.fieldset ?? null,
    v.asset.path ?? null,
    v.asset.versionHash,
    v.purpose,
    v.dimension ?? 'step',
    v.verdict,
    v.by,
  ]);
}
export function findApproval(
  approvals: readonly Approval[],
  step: string,
  subjectHash: string,
  subject?: string,
): Approval | undefined {
  return approvals
    .filter((a) => a.step === step && a.subjectHash === subjectHash && a.subject === subject)
    .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0))[0];
}
