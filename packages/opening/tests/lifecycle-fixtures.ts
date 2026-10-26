import {
  MemorySource,
  OpeningRecordBody,
  type StepCtx,
  createParamReader,
  versionHash,
} from '@osw/core';
import { OpeningRecord } from '../src/lifecycle/models.js';
export const now = '2026-03-01T12:00:00Z';
export const ref = { slot: 'template', id: 'example-checklist', versionHash: 'a'.repeat(64) };
export const checklist = {
  template: ref,
  firstDay: -2,
  lastDay: 40,
  items: [
    {
      key: 'permit',
      title: 'Example permit',
      phase: 'before',
      dayOffset: -2,
      dueDate: '2026-02-27',
      gate: true,
      waivable: false,
      status: 'done' as const,
      note: 'Example verified evidence',
    },
  ],
};
export const matrix = {
  plan: { ...ref, id: 'example-training' },
  seats: [{ seatId: 'seat-a', positionKey: 'cook', status: 'active' as const }],
  cells: [
    {
      seatId: 'seat-a',
      certKey: 'safety',
      critical: true,
      locked: true,
      state: 'passed' as const,
      attempts: 1,
      passedAt: '2026-02-28',
    },
  ],
  summary: {
    planTotal: 1,
    staffed: 1,
    gaps: [],
    certRequired: 1,
    certPassed: 1,
    criticalRequired: 1,
    criticalPassed: 1,
    criticalPending: 0,
    expiring: 0,
    hollow: false,
    ready: true,
  },
};
export const releaseInput = {
  storeId: 'example-opening-store',
  checklist,
  matrix,
  issues: [],
  timezone: 'UTC',
};
export function context(): StepCtx {
  return {
    assets: new MemorySource(),
    params: createParamReader([], now),
    approvals: [],
    now,
    actor: 'example:reviewer',
    providers: {},
  };
}
export async function record(overrides: Partial<ReturnType<typeof OpeningRecordBody.parse>> = {}) {
  const body = OpeningRecordBody.parse({
    menuRef: { ...ref, slot: 'menu', id: 'example-menu' },
    bomRef: { kind: 'Bom', id: 'example-bom', hash: ref.versionHash },
    decidedAt: now,
    track: 'example-noodle',
    jurisdiction: 'XE',
    timezone: 'UTC',
    openingDate: '2026-03-01',
    status: 'live',
    staffing: [{ positionKey: 'cook', planned: 1, staffed: 1 }],
    certMatrix: matrix,
    checklist,
    issues: [],
    release: {
      current: { state: 'ready', blockers: [] },
      signed: {
        snapshot: [],
        snapshotHash: await versionHash([]),
        decision: 'go',
        at: now,
        by: 'example:reviewer',
      },
    },
    marketing: {
      template: { ...ref, id: 'example-marketing' },
      items: [],
      ledger: [],
      assetGap: { required: 0, ready: 0, missing: 0, blockedChannels: [] },
    },
    reviews: [],
    handoff: null,
    ...overrides,
  });
  return OpeningRecord.parse({
    kind: 'OpeningRecord',
    artifactVersion: '0.1.0',
    id: 'example-opening',
    hash: await versionHash(body),
    storeId: 'example-opening-store',
    producedBy: { step: 'opening/assembleRecord', pkg: '@osw/opening', pkgVersion: '0.1.0' },
    createdAt: now,
    inputs: [],
    sources: [],
    example: true,
    body,
  });
}
export async function buildPlan(id: string, closed = false) {
  const { ArtifactEnvelope, BuildPlanBody } = await import('@osw/core');
  const usd = (amount: number) => ({ amount, currency: 'USD' });
  const body = BuildPlanBody.parse({
    drawings: [],
    landlordScope: [],
    quote: {
      currency: 'USD',
      lines: [],
      fees: [],
      laborRate: usd(10),
      fxUsed: {},
      options: { selfInstall: false, selfFreight: false },
      totals: { goods: usd(0), labor: usd(0), fees: usd(0), total: usd(0), laborHours: 0 },
      status: 'accepted',
      quoteHash: 'a'.repeat(64),
    },
    bids: [],
    schedule: {
      start: '2026-02-01',
      finish: '2026-03-01',
      tasks: [],
      criticalPath: [],
      blocked: [],
    },
    changes: [],
    acceptance: {
      status: closed ? 'accepted' : 'open',
      ...(closed ? { acceptedAt: now } : {}),
      checklist: [],
      lineChecks: [],
      siteChecks: [],
      punch: [
        {
          id: 'example-fault',
          title: 'Example Fault',
          severity: 'blocking',
          owner: 'example:contractor',
          ...(closed ? { closedAt: '2026-03-01' } : {}),
        },
      ],
      landlordChecks: [],
      handover: [],
    },
  });
  return ArtifactEnvelope('BuildPlan', BuildPlanBody).parse({
    kind: 'BuildPlan',
    artifactVersion: '0.1.0',
    id,
    hash: await versionHash(body),
    storeId: 'example-opening-store',
    producedBy: { step: 'build-out/acceptance', pkg: '@osw/build-out', pkgVersion: '0.1.0' },
    createdAt: now,
    sources: [ref],
    inputs: [],
    body,
  });
}
