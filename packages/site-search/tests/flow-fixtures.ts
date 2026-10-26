import { type Approval, type StepCtx, Template, versionHash } from '@osw/core';
import { csvListingFeed } from '../src/providers/csv-listing-feed.js';
import { manualEsign } from '../src/providers/esign-manual.js';
import { bytesHash } from '../src/providers/types.js';
import { run } from '../src/run.js';
import { freezeDocument } from '../src/steps/legal.js';
import { NOW, context, listingData, observed, record, spec } from './fixtures.js';
import { legalFixture, terms } from './legal-fixtures.js';

export async function sampleFlow() {
  const f = await legalFixture();
  const listings = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      record(
        'listing',
        `example-listing-${i + 1}`,
        listingData({
          source: { ...listingData().source, sourceListingId: `example-${i + 1}` },
          claims: [
            {
              key: 'clearHeight',
              measure: {
                ...observed(i < 2 ? 14 : 12, 'ft'),
                basis: 'claimed',
                refs: ['https://example.com/claims'],
              },
            },
          ],
        }),
      ),
    ),
  );
  const query = await record('competitor-query', 'example-query', {
    queries: ['example noodles'],
    lang: 'en',
  });
  query.coverage.tracks = [spec.concept.track];
  const area = await record('trade-area', 'example-population', {
    jurisdiction: 'XE',
    center: { lat: 0, lng: 0 },
    radiusKm: 10,
    residents: observed(20000),
    method: 'exact',
    period: '2026',
  });
  const checklist = await record(
    'template',
    'example-dd',
    Template.parse({
      kind: 'site-dd-checklist',
      jurisdiction: 'XE',
      lang: 'en',
      title: { en: 'Example checklist' },
      format: 'json',
      content: { checks: [{ key: 'zoning' }, { key: 'violations' }] },
    }),
  );
  const leaseTemplate = await record('template', 'example-lease', {
    ...f.template.data,
    kind: 'lease',
  });
  const document = await freezeDocument(
    leaseTemplate,
    'lease',
    'SYNTHETIC EXAMPLE LEASE — not a legal document',
    terms,
  );
  const ref = (r: { slot: string; id: string; versionHash: string }) => ({
    slot: r.slot,
    id: r.id,
    versionHash: r.versionHash,
  });
  const plan = {
    screenListings: { spec, center: { lat: 0, lng: 0 } },
    scanSurroundings: { decisionId: 'example-store' },
    shortlist: {
      entries: listings.map((r) => ({
        listing: ref(r),
        status: 'shortlisted',
        reason: r.id === listings[0]!.id ? 'Chosen example' : 'Less suitable example',
      })),
    },
    assessSite: {
      listing: listings[0],
      availability: observed(true),
      dueDiligence: [
        { key: 'zoning', complete: true, evidence: ['https://example.com/zoning'] },
        { key: 'violations', complete: true, evidence: ['https://example.com/violations'] },
      ],
    },
    surveySite: {
      readings: [
        ...f.site.body.conditions.map((c) => ({ key: c.key, measure: c.measure })),
        { key: 'foodUse' as const, measure: observed(true) },
      ],
    },
    chooseSite: {
      example: true as const,
      id: 'example-store',
      storeId: null,
      spec: { kind: 'StoreSpec', id: 'example-store', hash: await versionHash(spec) },
      openingTarget: '2026-06-01',
      unit: 'example-unit',
      floorLevel: 0,
    },
    matchCounsel: { languages: ['en'], engage: f.lawyer.id },
    draftLoi: { templateId: f.template.id, lang: 'en', terms, values: {} },
    reviewLease: { documents: [document] },
    signLease: { signers: [ref(f.tenant), ref(f.landlord)] },
  };
  const signedPdf = new TextEncoder().encode('%PDF-synthetic-example');
  const auditCertificate = new TextEncoder().encode('Synthetic audit certificate');
  const receipts = [
    {
      contentHash: document.contentHash,
      signedAt: NOW,
      envelopeRef: 'example-signed-envelope',
      signers: plan.signLease.signers,
      signedPdf,
      signedPdfHash: await bytesHash(signedPdf),
      auditCertificate,
      auditHash: await bytesHash(auditCertificate),
    },
  ];
  const records = [
    ...f.records.filter((r) => r.slot !== 'listing'),
    ...listings,
    query,
    area,
    checklist,
    leaseTemplate,
    ...(await Promise.all(
      ['direct', 'adjacent', 'substitute'].map((kind, i) =>
        record('place-observation', `example-observation-${i}`, {
          provider: 'example',
          providerPlaceId: `example-place-${i}`,
          kind,
          observedAt: NOW,
          curatedBy: 'example-researcher',
        }),
      ),
    )),
  ];
  const makeContext = (approvals: Approval[]) => {
    const ctx = context(records, {
      approvals,
      providers: {
        places: {
          name: 'example',
          persistable: ['providerPlaceId'],
          maxCacheSeconds: 0,
          search: async () =>
            Array.from({ length: 3 }, (_, i) => ({
              providerPlaceId: `example-place-${i}`,
              geo: { lat: 0.001 * i, lng: 0 },
            })),
        },
        listingFeed: csvListingFeed('id\nexample-vacancy', () => listingData()),
        esign: manualEsign(receipts),
      },
    });
    const params = ctx.params;
    ctx.params = {
      get: (key, scope) => (key === 'site.shortlistMax' ? { value: 10 } : params.get(key, scope)),
    };
    return ctx;
  };
  const approvals: Approval[] = [];
  for (let round = 0; round < 12; round++) {
    const output = await run(plan, makeContext(approvals));
    const blockers = output.needs.filter((n) => n.blocking);
    if (!blockers.length) return { plan, records, approvals, output, makeContext, receipts };
    const pending = blockers.filter((n) => n.kind === 'approval');
    if (pending.length !== blockers.length) throw new Error(JSON.stringify(blockers));
    for (const need of pending) {
      const decisions: Record<string, string> = {
        shortlist: 'accept',
        chooseSite: 'choose',
        matchCounsel: 'engage',
        draftLoi: 'send',
        reviewLease: 'approve',
        signLease: 'sign',
      };
      approvals.push({
        step: need.step,
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision: decisions[need.step.split('/')[1]!]!,
        by: 'example-human',
        at: NOW,
        ...(need.step === 'site-search/reviewLease'
          ? { role: 'lawyer', party: ref(f.lawyer) }
          : {}),
      });
    }
  }
  throw new Error('Example approval sequence failed to converge');
}
