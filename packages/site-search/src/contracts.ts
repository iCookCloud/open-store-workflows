import { ArtifactEnvelope, SiteDecisionBody, SiteDecisionRent, type z } from '@osw/core';
export const Lease = SiteDecisionBody.shape.lease.unwrap();
// 共享结构由 core 定义；本流程额外强制跨字段状态约束。
export const CheckedSiteDecisionBody = SiteDecisionBody.superRefine((site, ctx) => {
  const issue = (message: string, path: (string | number)[]) =>
    ctx.addIssue({ code: 'custom', message, path });
  if (new Set(site.shortlist.map((s) => s.listing.id)).size !== site.shortlist.length)
    issue('Duplicate shortlist listing', ['shortlist']);
  if (site.shortlist.some((s) => s.status === 'rejected' && !s.reason.trim()))
    issue('Rejection requires a reason', ['shortlist']);
  if (
    site.lease &&
    (site.lease.rent.base.amount < 0 ||
      site.lease.rent.additional.some((r) => r.estimate && r.estimate.amount < 0))
  )
    issue('Rent amounts cannot be negative', ['lease', 'rent']);
  if (site.lease?.rent.basis === 'per_area' && !site.lease.rent.areaUnit)
    issue('Per-area rent requires areaUnit', ['lease', 'rent', 'areaUnit']);
  if (site.lease?.possessionDate && site.openingTarget < site.lease.possessionDate)
    issue('Opening cannot precede possession', ['openingTarget']);
  if (site.stage === 'signed') {
    if (site.conditions.some((c) => c.required?.hard && c.verdict === 'fails'))
      issue('Unresolved hard requirements', ['conditions']);
    if (!site.lease?.documents.some((d) => d.kind === 'lease'))
      issue('Lease document required', ['lease', 'documents']);
    if (
      site.lease?.documents.some(
        (d) => ['lease', 'rider', 'guarantee'].includes(d.kind) && (!d.signedAt || !d.envelopeRef),
      )
    )
      issue('Signature and envelope reference required', ['lease', 'documents']);
  }
});
export const SiteDecision = ArtifactEnvelope('SiteDecision', CheckedSiteDecisionBody);
export type SiteDecision = z.infer<typeof SiteDecision>;
export { SiteDecisionRent };
