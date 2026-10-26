import {
  AssetRef,
  IsoDateTime,
  type Need,
  type StepCtx,
  type Verification,
  convertUnit,
  partySlot,
  versionHash,
  z,
} from '@osw/core';
import { getMany } from '@osw/core';
import { CheckedSiteDecisionBody, SiteDecision } from '../contracts.js';
import { bytesHash, siteProviders } from '../providers/types.js';
import { approvalFor } from '../rules/approval.js';
import { inputNeed, result } from '../rules/common.js';
import { evidenceProblem } from '../rules/measure.js';
import { moneyIn, monthlyRent } from '../rules/rent.js';
import { listingSlot } from '../slots/listing.js';
import { LeaseReviewInput, reviewLease } from './legal.js';
export const SignInput = z.object({
  site: SiteDecision,
  review: LeaseReviewInput,
  signers: z.array(AssetRef).min(2),
});
export async function signLease(raw: z.infer<typeof SignInput>, ctx: StepCtx) {
  const input = SignInput.parse(raw);
  const needs: Need[] = [];
  const review = await reviewLease(input.review, ctx);
  needs.push(...review.needs);
  if (input.site.body.stage !== 'loi')
    needs.push(inputNeed('site.stage', 'A LOI-stage decision is required'));
  if (input.review.jurisdiction !== input.site.body.jurisdiction)
    needs.push(inputNeed('review.jurisdiction', 'Review must cover the selected site'));
  if ((await versionHash(input.site.body)) !== input.site.hash)
    needs.push(inputNeed('site.hash', 'Decision hash mismatch'));
  if (!input.review.documents.some((d) => d.kind === 'lease'))
    needs.push(inputNeed('documents', 'A lease document is required'));
  const unmeasured = [];
  for (const requirement of input.site.body.unmeasured) {
    if (requirement.hard) {
      const waiver = await approvalFor(
        ctx,
        'site-search/chooseSite',
        `condition:${requirement.key}`,
        { listing: input.site.body.listing, requirement },
        'waive',
        needs,
      );
      if (!waiver) unmeasured.push(requirement);
    } else unmeasured.push(requirement);
  }
  for (const condition of input.site.body.conditions) {
    if (condition.verdict !== 'waived') {
      const evidence = evidenceProblem(condition.measure, ctx, needs, true);
      if (evidence) needs.push(inputNeed(`conditions.${condition.key}`, evidence));
    }
    if (condition.required?.hard && condition.verdict === 'fails')
      needs.push(inputNeed(`conditions.${condition.key}`, 'Failed hard condition has no waiver'));
    if (condition.verdict === 'waived')
      await approvalFor(
        ctx,
        'site-search/chooseSite',
        `condition:${condition.key}`,
        { listing: input.site.body.listing, condition: { ...condition, verdict: 'fails' } },
        'waive',
        needs,
      );
  }
  const parties = await getMany(
    ctx.assets,
    partySlot,
    input.signers.map((s) => s.id),
  );
  if (
    new Set(input.signers.map((s) => s.id)).size !== input.signers.length ||
    input.signers.some(
      (s) =>
        s.slot !== 'party' ||
        !parties.some(
          (p) => p.id === s.id && p.versionHash === s.versionHash && p.data.status === 'active',
        ),
    )
  )
    needs.push(inputNeed('signers', 'Signers must reference distinct current active parties'));
  for (const document of input.review.documents)
    await approvalFor(
      ctx,
      'site-search/signLease',
      undefined,
      document.contentHash,
      'sign',
      needs,
      undefined,
      true,
    );
  if (!siteProviders(ctx).esign)
    needs.push({
      kind: 'provider',
      name: 'esign',
      reason: 'Signing evidence provider is required',
      blocking: true,
    });
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const signedDocuments = [];
  for (const document of input.review.documents) {
    try {
      const receipt = await siteProviders(ctx).esign!.collect({
        contentHash: document.contentHash,
        signers: input.signers,
      });
      if (!receipt) {
        needs.push({
          kind: 'action',
          action: 'collectSignedDocument',
          ref: document.contentHash,
          reason: 'Signed PDF and audit certificate are missing',
          blocking: true,
        });
        continue;
      }
      if (
        receipt.contentHash !== document.contentHash ||
        !receipt.envelopeRef ||
        !IsoDateTime.safeParse(receipt.signedAt).success ||
        receipt.signedAt > ctx.now ||
        !receipt.signedPdf.length ||
        !receipt.auditCertificate.length ||
        (await bytesHash(receipt.signedPdf)) !== receipt.signedPdfHash ||
        (await bytesHash(receipt.auditCertificate)) !== receipt.auditHash
      ) {
        needs.push(inputNeed('receipt', 'Invalid or changed signed document evidence'));
        continue;
      }
      signedDocuments.push({
        template: {
          slot: document.template.slot,
          id: document.template.id,
          versionHash: document.template.versionHash,
        },
        kind: document.kind,
        contentHash: document.contentHash,
        signedAt: receipt.signedAt,
        envelopeRef: receipt.envelopeRef,
      });
    } catch {
      needs.push({
        kind: 'provider',
        name: 'esign',
        reason: 'Signing evidence could not be verified',
        blocking: true,
      });
    }
  }
  if (needs.some((n) => n.blocking)) return result(null, needs);
  const terms = input.review.documents.find((d) => d.kind === 'lease')!.terms;
  const body = {
    ...input.site.body,
    stage: 'signed' as const,
    unmeasured,
    lease: { ...terms, documents: signedDocuments },
  };
  const parsed = CheckedSiteDecisionBody.safeParse(body);
  if (!parsed.success)
    return result(
      null,
      parsed.error.issues.map((i) => inputNeed(i.path.join('.'), i.message)),
    );
  if (terms.rentCommencementDate && terms.rentCommencementDate < body.openingTarget)
    needs.push({
      kind: 'action',
      action: 'reviewRentStart',
      reason: 'Rent starts before planned opening',
      blocking: false,
    });
  const verifications = [...review.verifications];
  const listing = await ctx.assets.get(listingSlot, input.site.body.listing.id);
  if (!listing || listing.versionHash !== input.site.body.listing.versionHash)
    return result(null, [
      inputNeed('listing', 'Listing changed since selection; reassess before signing'),
    ]);
  const area = body.conditions.find((c) => c.key === 'area')?.measure;
  if (listing.data.askingRent && area && typeof area.value === 'number' && area.unit) {
    const areaM2 = convertUnit(area.value, area.unit, 'm2').value;
    if (areaM2 !== null) {
      const advertised = monthlyRent(listing.data.askingRent, areaM2);
      const actual = moneyIn(monthlyRent(terms.rent, areaM2), advertised.currency, ctx, needs);
      verifications.push({
        asset: body.listing,
        purpose: 'site-search/signLease',
        dimension: 'askingRent',
        verdict: actual ? (actual.amount <= advertised.amount ? 'holds' : 'fails') : 'pending',
        reason: 'Signed monthly base rent compared with advertised monthly base rent',
        at: ctx.now,
        by: ctx.actor,
        ...(actual
          ? {
              measured: {
                field: 'askingRent',
                expected: advertised.amount,
                actual: actual.amount,
                unit: advertised.currency,
                delta: actual.amount - advertised.amount,
              },
            }
          : {}),
      });
    }
  } else
    verifications.push({
      asset: body.listing,
      purpose: 'site-search/signLease',
      dimension: 'askingRent',
      verdict: 'pending',
      reason: 'Advertised rent or measured area is missing',
      at: ctx.now,
      by: ctx.actor,
    });
  return {
    ...result(
      {
        ...input.site,
        body: parsed.data,
        hash: await versionHash(body),
        createdAt: ctx.now,
        sources: [
          ...input.site.sources,
          input.review.counsel,
          ...input.review.documents.map((d) => ({
            slot: d.template.slot,
            id: d.template.id,
            versionHash: d.template.versionHash,
          })),
        ],
        producedBy: { step: 'site-search/signLease', pkg: '@osw/site-search', pkgVersion: '0.1.0' },
      },
      needs,
    ),
    verifications,
  };
}
