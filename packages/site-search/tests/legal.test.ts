import {
  type Approval,
  AssetRecord,
  Party,
  SiteDecisionBody,
  type StepCtx,
  Template,
  versionHash,
  z,
} from '@osw/core';
import { describe, expect, it } from 'vitest';
import { CheckedSiteDecisionBody, Lease, SiteDecision } from '../src/contracts.js';
import { manualEsign } from '../src/providers/esign-manual.js';
import { bytesHash } from '../src/providers/types.js';
import {
  documentHash,
  draftLoi,
  freezeDocument,
  matchCounsel,
  reviewLease,
} from '../src/steps/legal.js';
import { chooseSite, shortlist, siteEnvelope } from '../src/steps/selection.js';
import { signLease } from '../src/steps/sign.js';
import { NOW, approve, context, listingData, observed, record, spec } from './fixtures.js';

import { legalFixture, signedFixture, terms } from './legal-fixtures.js';
describe('selection and artifact invariants', () => {
  it('rejects multiple chosen and signed hard-unmeasured states', async () => {
    const f = await legalFixture();
    expect(
      CheckedSiteDecisionBody.safeParse({
        ...f.site.body,
        shortlist: [...f.site.body.shortlist, ...f.site.body.shortlist],
      }).success,
    ).toBe(false);
    expect(
      CheckedSiteDecisionBody.safeParse({
        ...f.site.body,
        stage: 'signed',
        lease: terms,
        unmeasured: spec.siteRequirements,
      }).success,
    ).toBe(false);
  });
  it('binds shortlist approval to current entries and rejects invalid transitions', async () => {
    const f = await legalFixture();
    const entries = [{ listing: f.ref, status: 'shortlisted' as const, reason: 'Candidate' }];
    const a = await approve('site-search/shortlist', 'shortlist', entries, 'accept');
    expect((await shortlist({ entries }, context(f.records, { approvals: [a] }))).output).toEqual(
      entries,
    );
    expect(
      (
        await shortlist(
          { entries: [{ ...entries[0]!, reason: 'Changed' }] },
          context(f.records, { approvals: [a] }),
        )
      ).output,
    ).toBeNull();
    expect(
      (
        await shortlist(
          { entries: [{ ...entries[0]!, status: 'chosen' }] },
          context(f.records, { approvals: [a] }),
        )
      ).needs.some((n) => n.kind === 'input'),
    ).toBe(true);
  });
  it('allows choosing with pending hard readings but requires a visited version', async () => {
    const f = await legalFixture();
    const input = {
      id: f.site.id,
      storeId: null,
      spec: { kind: 'StoreSpec' as const, id: 'example-store', hash: await versionHash(spec) },
      listing: f.listing,
      shortlist: [{ listing: f.ref, status: 'visited' as const, reason: 'Surveyed' }],
      survey: {
        conditions: f.site.body.conditions,
        unmeasured: [{ key: 'zoningUse' as const, op: 'eq' as const, value: 'food', hard: true }],
      },
      openingTarget: f.site.body.openingTarget,
      unit: f.site.body.unit,
      floorLevel: 0,
    };
    const first = await chooseSite(input, context(f.records));
    const need = first.needs.find((n) => n.kind === 'approval');
    expect(need?.kind).toBe('approval');
    if (need?.kind !== 'approval') throw new Error('Approval expected');
    const approval: Approval = {
      step: need.step,
      subject: need.subject,
      subjectHash: need.subjectHash,
      decision: 'choose',
      by: 'example-owner',
      at: NOW,
    };
    expect(
      (await chooseSite(input, context(f.records, { approvals: [approval] }))).output?.body
        .unmeasured,
    ).toHaveLength(1);
  });
});

describe('documents and signing', () => {
  it('requires two matching counsel and hash-bound engagement', async () => {
    const f = await legalFixture();
    const input = { jurisdiction: 'XE', languages: ['en'], engage: f.lawyer.id };
    const first = await matchCounsel(input, context(f.records));
    expect(first.output).toBeNull();
    const n = first.needs.find((n) => n.kind === 'approval');
    if (n?.kind !== 'approval') throw new Error('Approval missing');
    const approval: Approval = {
      step: n.step,
      subject: n.subject,
      subjectHash: n.subjectHash,
      decision: 'engage',
      by: 'example-owner',
      at: NOW,
    };
    expect(
      (await matchCounsel(input, context(f.records, { approvals: [approval] }))).output?.candidates,
    ).toHaveLength(2);
    expect(
      (await matchCounsel(input, context([f.lawyer], { approvals: [approval] }))).needs,
    ).toContainEqual(expect.objectContaining({ kind: 'asset', slot: 'party' }));
  });
  it('blocks wrong jurisdiction and unresolved required placeholders', async () => {
    const f = await legalFixture();
    const bad = await record('template', 'bad', {
      ...f.template.data,
      jurisdiction: 'XF',
      body: 'Required {{missing}}',
      placeholders: [{ key: 'missing', token: '{{missing}}', required: true }],
    });
    const output = await draftLoi(
      { site: f.site, templateId: 'bad', lang: 'en', terms, values: {} },
      context([...f.records, bad]),
    );
    expect(output.output).toBeNull();
    expect(output.needs.some((n) => n.kind === 'asset')).toBe(true);
    expect(output.needs.some((n) => n.kind === 'input')).toBe(true);
  });
  it('detects 3 to 1 free-rent drift and requires lawyer acknowledgement by key', async () => {
    const f = await signedFixture();
    const changed = { ...terms, rent: { ...terms.rent, freeRentMonths: 1 } };
    const doc = await freezeDocument(f.doc.template, 'lease', f.doc.content, changed);
    const input = { ...f.review, documents: [doc] };
    const approval = { ...f.approvals[0]!, subjectHash: doc.contentHash };
    const blocked = await reviewLease(input, context(f.records, { approvals: [approval] }));
    expect(blocked.output).toBeNull();
    expect(blocked.needs).toContainEqual(expect.objectContaining({ path: 'approval.note' }));
    const accepted = await reviewLease(
      input,
      context(f.records, { approvals: [{ ...approval, note: 'rent.freeRentMonths' }] }),
    );
    expect(accepted.output?.drift).toHaveLength(1);
    expect(accepted.verifications[0]?.verdict).toBe('fails');
  });
  it('invalidates lawyer approval when either text or structured terms changes', async () => {
    const f = await signedFixture();
    for (const doc of [
      { ...f.doc, content: `${f.doc.content}!` },
      { ...f.doc, terms: { ...terms, termMonths: 120 } },
    ]) {
      const out = await reviewLease({ ...f.review, documents: [doc] }, f.ctx);
      expect(out.output).toBeNull();
      expect(out.needs).toContainEqual(expect.objectContaining({ path: 'documents.contentHash' }));
    }
    const noLawyer = context(f.records, { approvals: [{ ...f.approvals[0]!, role: undefined }] });
    expect((await reviewLease(f.review, noLawyer)).output).toBeNull();
  });
  it('requires signing approval before collecting and verifies returned evidence hashes', async () => {
    const f = await signedFixture();
    const input = { site: f.site, review: f.review, signers: f.signers };
    const blocked = await signLease(input, { ...f.ctx, approvals: [f.approvals[0]!] });
    expect(blocked.output).toBeNull();
    expect(blocked.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', step: 'site-search/signLease' }),
    );
    const signed = await signLease(input, f.ctx);
    expect(signed.output?.body.stage).toBe('signed');
    expect(SiteDecision.safeParse(signed.output).success).toBe(true);
    const bad = {
      collect: async () => {
        const receipt = await f.provider.collect({
          contentHash: f.doc.contentHash,
          signers: f.signers,
        });
        return { ...receipt!, signedPdfHash: '0'.repeat(64) };
      },
    };
    expect((await signLease(input, { ...f.ctx, providers: { esign: bad } })).output).toBeNull();
  });
  it('blocks unmeasured hard conditions and opening before possession', async () => {
    const f = await signedFixture();
    const body = {
      ...f.site.body,
      unmeasured: [{ key: 'zoningUse' as const, op: 'eq' as const, value: 'food', hard: true }],
    };
    const site = { ...f.site, body, hash: await versionHash(body) };
    expect(
      (await signLease({ site, review: f.review, signers: f.signers }, f.ctx)).output,
    ).toBeNull();
    expect(
      CheckedSiteDecisionBody.safeParse({ ...f.site.body, openingTarget: '2026-01-01' }).success,
    ).toBe(false);
  });
});
