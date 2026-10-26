import { type Approval, Party, SiteDecisionBody, Template, versionHash, type z } from '@osw/core';
import { type Lease, SiteDecision } from '../src/contracts.js';
import { manualEsign } from '../src/providers/esign-manual.js';
import { bytesHash } from '../src/providers/types.js';
import { freezeDocument } from '../src/steps/legal.js';
import { siteEnvelope } from '../src/steps/selection.js';
import { NOW, context, listingData, observed, record, spec } from './fixtures.js';

export const terms: z.infer<typeof Lease> = {
  termMonths: 60,
  renewals: [],
  possessionDate: '2026-02-01',
  rentCommencementDate: '2026-05-01',
  rent: {
    base: { amount: 2000, currency: 'USD' },
    period: 'month',
    basis: 'total',
    escalation: { kind: 'none', value: null, everyMonths: 12 },
    freeRentMonths: 3,
    additional: [],
  },
  deposit: { amount: 2000, currency: 'USD' },
  tiAllowance: { amount: 10000, currency: 'USD' },
  guarantee: { kind: 'none', cap: null },
  permittedUse: 'Example food service',
  exclusiveUse: false,
  assignment: 'consent',
  deliveryCondition: 'second_gen_food',
  landlordWork: [],
  documents: [],
};
export async function legalFixture() {
  const listing = await record('listing', 'site', listingData());
  const ref = { slot: listing.slot, id: listing.id, versionHash: listing.versionHash };
  const conditions = [
    { key: 'area', measure: observed(100, 'm2') },
    { key: 'frontage', measure: observed(20, 'ft') },
    { key: 'clearHeight', measure: observed(12, 'ft') },
    { key: 'powerCapacity', measure: observed(100, 'kW') },
    { key: 'gasService', measure: observed(true) },
    { key: 'exhaustPath', measure: observed('existing') },
  ].map((c) => ({ ...c, verdict: 'holds' as const }));
  const body = SiteDecisionBody.parse({
    stage: 'chosen',
    listing: ref,
    address: listing.data.address,
    geo: listing.data.geo,
    jurisdiction: 'XE',
    unit: 'example-unit',
    floorLevel: 0,
    conditions,
    unmeasured: [],
    openingTarget: '2026-06-01',
    lease: null,
    shortlist: [{ listing: ref, status: 'chosen', reason: 'Selected after survey' }],
  });
  const site = SiteDecision.parse(
    await siteEnvelope(
      body,
      'example-store',
      null,
      [{ kind: 'StoreSpec', id: 'example-store', hash: await versionHash(spec) }],
      [ref],
      context(),
      'chooseSite',
    ),
  );
  const template = await record(
    'template',
    'example-loi',
    Template.parse({
      kind: 'loi',
      lang: 'en',
      title: { en: 'Synthetic example only' },
      format: 'markdown',
      jurisdiction: 'XE',
      body: 'Example only. Free rent: {{months}} months. Use: {{use}}.',
      placeholders: [
        { token: '{{months}}', key: 'rent.freeRentMonths', required: true },
        { token: '{{use}}', key: 'permittedUse', required: true },
      ],
      termKeys: ['rent.freeRentMonths', 'permittedUse'],
      requiresCounselReview: true,
    }),
  );
  const partyData = Party.parse({
    name: { en: 'Example Counsel' },
    roles: ['lawyer'],
    status: 'active',
    jurisdictions: ['XE'],
    languages: ['en'],
    profiles: {
      lawyer: {
        matters: ['lease'],
        stance: 'tenant',
        caseTypes: [],
        chinaLanding: 'none',
        engagement: ['matter'],
      },
    },
  });
  const lawyer = await record('party', 'lawyer-one', partyData);
  const backup = await record('party', 'lawyer-two', partyData);
  const tenant = await record(
    'party',
    'tenant',
    Party.parse({ name: { en: 'Example tenant' }, roles: ['creator'], status: 'active' }),
  );
  const landlord = await record(
    'party',
    'landlord',
    Party.parse({ name: { en: 'Example landlord' }, roles: ['landlord'], status: 'active' }),
  );
  return {
    listing,
    ref,
    site,
    template,
    lawyer,
    backup,
    tenant,
    landlord,
    records: [listing, template, lawyer, backup, tenant, landlord],
  };
}
const ref = (a: { slot: string; id: string; versionHash: string }) => ({
  slot: a.slot,
  id: a.id,
  versionHash: a.versionHash,
});
export async function signedFixture() {
  const f = await legalFixture();
  const leaseTemplate = await record('template', 'example-lease', {
    ...f.template.data,
    kind: 'lease',
  });
  const doc = await freezeDocument(leaseTemplate, 'lease', 'SYNTHETIC EXAMPLE: lease text', terms);
  const loiBody = { ...f.site.body, stage: 'loi' as const, lease: terms };
  const site = SiteDecision.parse({ ...f.site, body: loiBody, hash: await versionHash(loiBody) });
  const review = { loi: terms, documents: [doc], jurisdiction: 'XE', counsel: ref(f.lawyer) };
  const signers = [ref(f.tenant), ref(f.landlord)];
  const approvals: Approval[] = [
    {
      step: 'site-search/reviewLease',
      subjectHash: doc.contentHash,
      decision: 'approve',
      by: 'example-lawyer',
      role: 'lawyer',
      party: ref(f.lawyer),
      at: NOW,
    },
    {
      step: 'site-search/signLease',
      subjectHash: doc.contentHash,
      decision: 'sign',
      by: 'example-owner',
      at: NOW,
    },
  ];
  const signedPdf = new TextEncoder().encode('%PDF-synthetic-signed-example');
  const auditCertificate = new TextEncoder().encode('Synthetic audit certificate');
  const provider = manualEsign([
    {
      contentHash: doc.contentHash,
      signedAt: NOW,
      envelopeRef: 'example-envelope',
      signers,
      signedPdf,
      signedPdfHash: await bytesHash(signedPdf),
      auditCertificate,
      auditHash: await bytesHash(auditCertificate),
    },
  ]);
  const ctx = context([...f.records, leaseTemplate], { approvals, providers: { esign: provider } });
  return {
    ...f,
    records: [...f.records, leaseTemplate],
    doc,
    site,
    review,
    signers,
    ctx,
    approvals,
    provider,
  };
}
