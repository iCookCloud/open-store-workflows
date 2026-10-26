import {
  AssetRecord,
  AssetRef,
  type Need,
  Party,
  type StepCtx,
  Template,
  type Verification,
  getMany,
  isWithin,
  jurisdictionPrefixes,
  partySlot,
  templateSlot,
  versionHash,
  z,
} from '@osw/core';
import { CheckedSiteDecisionBody, Lease, SiteDecision } from '../contracts.js';
import { approvalFor } from '../rules/approval.js';
import { assetRef, inputNeed, queryAll, result } from '../rules/common.js';

export const CounselInput = z.object({
  jurisdiction: z.string(),
  languages: z.array(z.string()),
  engage: z.string(),
});
export const CounselShortlist = z.object({
  candidates: z.array(AssetRecord(Party)),
  engaged: AssetRef,
});
export async function matchCounsel(raw: z.infer<typeof CounselInput>, ctx: StepCtx) {
  const input = CounselInput.parse(raw);
  const needs: Need[] = [];
  const filter = {
    all: [
      { field: 'roles', op: 'hasAny', value: ['lawyer'] },
      { field: 'status', op: 'eq', value: 'active' },
      { field: 'jurisdictions', op: 'hasAny', value: jurisdictionPrefixes(input.jurisdiction) },
      { field: 'profiles.lawyer.matters', op: 'hasAny', value: ['lease'] },
      { not: { field: 'profiles.lawyer.stance', op: 'eq', value: 'landlord' } },
    ],
  } as const;
  const candidates = await queryAll(ctx, partySlot, structuredClone(filter) as never, 200);
  candidates.sort(
    (a, b) =>
      (b.data.languages?.filter((l) => input.languages.includes(l)).length ?? 0) -
        (a.data.languages?.filter((l) => input.languages.includes(l)).length ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
  if (candidates.length < 2)
    needs.push({
      kind: 'asset',
      slot: 'party',
      filter,
      reason: 'At least two eligible counsel are required for a conflict backup',
      blocking: true,
    });
  const selected = candidates.find((c) => c.id === input.engage);
  if (!selected) needs.push(inputNeed('engage', 'Choose eligible counsel'));
  else
    await approvalFor(
      ctx,
      'site-search/matchCounsel',
      `party:${selected.id}`,
      { party: assetRef(selected), jurisdiction: input.jurisdiction },
      'engage',
      needs,
    );
  return result(selected ? { candidates, engaged: assetRef(selected) } : null, needs);
}
export const Document = z.object({
  template: AssetRecord(Template),
  kind: z.enum(['loi', 'lease', 'rider', 'guarantee', 'sublease']),
  content: z.string().min(1),
  contentHash: z.string(),
  terms: Lease,
});
// 批示绑定正文与结构化条款；签署状态属于信封，不参与正文快照，避免循环引用。
export async function documentHash(content: string, terms: z.infer<typeof Lease>): Promise<string> {
  const { documents, ...businessTerms } = Lease.parse(terms);
  return versionHash({ content, terms: businessTerms });
}
export async function freezeDocument(
  template: z.infer<ReturnType<typeof AssetRecord<typeof Template>>>,
  kind: z.infer<typeof Document>['kind'],
  content: string,
  terms: z.infer<typeof Lease>,
) {
  return Document.parse({
    template,
    kind,
    content,
    terms,
    contentHash: await documentHash(content, terms),
  });
}
export const LoiInput = z.object({
  site: SiteDecision,
  templateId: z.string(),
  lang: z.string(),
  terms: Lease,
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export const DocDraft = z.object({
  site: SiteDecision,
  document: Document,
  unresolved: z.array(z.string()),
});
export function unresolvedTokens(template: z.infer<typeof Template>, content: string): string[] {
  return (template.placeholders ?? [])
    .filter((p) => p.required && content.includes(p.token))
    .map((p) => p.key);
}
export function atPath(object: unknown, key: string): unknown {
  let current = object;
  for (const part of key.split('.')) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(part) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function validateTemplate(
  template: z.infer<typeof Template>,
  jurisdiction: string,
  needs: Need[],
): void {
  if (!template.jurisdiction || !isWithin(jurisdiction, template.jurisdiction))
    needs.push({
      kind: 'asset',
      slot: 'template',
      filter: null,
      reason: 'Template jurisdiction does not cover this site',
      blocking: true,
    });
}
export async function draftLoi(raw: z.infer<typeof LoiInput>, ctx: StepCtx) {
  const input = LoiInput.parse(raw);
  const needs: Need[] = [];
  const template = await ctx.assets.get(templateSlot, input.templateId);
  if (
    !template ||
    template.data.kind !== 'loi' ||
    template.data.lang !== input.lang ||
    !template.data.body
  )
    return result(null, [
      {
        kind: 'asset',
        slot: 'template',
        filter: null,
        reason: 'Matching LOI template required',
        blocking: true,
      },
    ]);
  validateTemplate(template.data, input.site.body.jurisdiction, needs);
  let content = template.data.body;
  for (const placeholder of template.data.placeholders ?? []) {
    const term = atPath(input.terms, placeholder.key);
    const value = term ?? input.values[placeholder.key];
    if (value !== undefined && value !== null)
      content = content
        .split(placeholder.token)
        .join(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const unresolved = unresolvedTokens(template.data, content);
  if (unresolved.length)
    needs.push(inputNeed('values', `Unresolved required placeholders: ${unresolved.join(', ')}`));
  const contentHash = await documentHash(content, input.terms);
  const document = { template, kind: 'loi' as const, content, contentHash, terms: input.terms };
  const body = {
    ...input.site.body,
    stage: 'loi' as const,
    lease: {
      ...input.terms,
      documents: [
        {
          template: assetRef(template),
          kind: 'loi' as const,
          contentHash,
          signedAt: null,
          envelopeRef: null,
        },
      ],
    },
  };
  const parsed = CheckedSiteDecisionBody.safeParse(body);
  if (!parsed.success)
    needs.push(...parsed.error.issues.map((i) => inputNeed(i.path.join('.'), i.message)));
  await approvalFor(
    ctx,
    'site-search/draftLoi',
    undefined,
    contentHash,
    'send',
    needs,
    undefined,
    true,
  );
  return result(
    {
      site: {
        ...input.site,
        body,
        hash: await versionHash(body),
        sources: [...input.site.sources, assetRef(template)],
        createdAt: ctx.now,
        producedBy: { step: 'site-search/draftLoi', pkg: '@osw/site-search', pkgVersion: '0.1.0' },
      },
      document,
      unresolved,
    },
    needs,
  );
}
export const LeaseReviewInput = z.object({
  loi: Lease,
  documents: z.array(Document).min(1),
  jurisdiction: z.string(),
  counsel: AssetRef,
});
export const LeaseReview = z.object({
  documents: z.array(Document),
  drift: z.array(
    z.object({ document: z.string(), key: z.string(), before: z.unknown(), after: z.unknown() }),
  ),
  counsel: AssetRef,
});
export async function reviewLease(raw: z.infer<typeof LeaseReviewInput>, ctx: StepCtx) {
  const input = LeaseReviewInput.parse(raw);
  const needs: Need[] = [];
  const verifications: Verification[] = [];
  const drift: z.infer<typeof LeaseReview>['drift'] = [];
  const counsel = await ctx.assets.get(partySlot, input.counsel.id);
  if (
    !counsel ||
    counsel.versionHash !== input.counsel.versionHash ||
    !counsel.data.roles.includes('lawyer') ||
    counsel.data.status !== 'active' ||
    !counsel.data.jurisdictions?.some((j) => isWithin(input.jurisdiction, j))
  )
    needs.push(inputNeed('counsel', 'Current eligible counsel for this jurisdiction is required'));
  const currentTemplates = await getMany(
    ctx.assets,
    templateSlot,
    input.documents.map((d) => d.template.id),
  );
  for (const document of input.documents) {
    if (
      !currentTemplates.some(
        (t) => t.id === document.template.id && t.versionHash === document.template.versionHash,
      )
    )
      needs.push(
        inputNeed(
          'documents.template',
          'Template changed since drafting; review the current version',
        ),
      );
    if (
      (await documentHash('', document.terms)) !==
      (await documentHash('', input.documents[0]!.terms))
    )
      needs.push(
        inputNeed(
          'documents.terms',
          'Lease, rider and guarantee must describe one reconciled final set of terms',
        ),
      );
    validateTemplate(document.template.data, input.jurisdiction, needs);
    if (document.template.data.kind !== document.kind)
      needs.push(inputNeed('documents.kind', 'Document and template kinds differ'));
    if ((await documentHash(document.content, document.terms)) !== document.contentHash)
      needs.push(inputNeed('documents.contentHash', 'Frozen document hash mismatch'));
    if (unresolvedTokens(document.template.data, document.content).length)
      needs.push(inputNeed('documents.content', 'Required placeholders remain'));
    const keys = document.template.data.termKeys;
    if (!keys?.length)
      needs.push(
        inputNeed('documents.template.termKeys', 'Term keys are required for drift review'),
      );
    const changed: string[] = [];
    for (const key of keys ?? []) {
      const before = atPath(input.loi, key);
      const after = atPath(document.terms, key);
      if (before === undefined || after === undefined) {
        needs.push(inputNeed(`terms.${key}`, 'Declared term key is missing'));
        continue;
      }
      if ((await versionHash(before)) !== (await versionHash(after))) {
        changed.push(key);
        drift.push({ document: document.contentHash, key, before, after });
      }
    }
    const approval = await approvalFor(
      ctx,
      'site-search/reviewLease',
      undefined,
      document.contentHash,
      'approve',
      needs,
      'lawyer',
      true,
    );
    if (
      approval &&
      (approval.party?.id !== input.counsel.id ||
        approval.party.versionHash !== input.counsel.versionHash)
    )
      needs.push(
        inputNeed('approval.party', 'Approval must reference the selected counsel and version'),
      );
    if (approval && changed.some((key) => !approval.note?.split(/[\s,;，；]+/).includes(key)))
      needs.push(
        inputNeed(
          'approval.note',
          `Counsel must acknowledge every changed term: ${changed.join(', ')}`,
        ),
      );
    verifications.push({
      asset: assetRef(document.template),
      purpose: 'site-search/reviewLease',
      dimension: 'termKeys',
      verdict: approval ? (changed.length ? 'fails' : 'holds') : 'pending',
      reason: changed.length ? changed.join(', ').slice(0, 500) : 'No material term changes',
      at: ctx.now,
      by: ctx.actor,
    });
  }
  return {
    ...result({ documents: input.documents, drift, counsel: input.counsel }, needs),
    verifications,
  };
}
