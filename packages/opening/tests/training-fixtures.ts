import {
  type AnyAssetRecord,
  MemorySource,
  SHARED_SLOTS,
  type StepCtx,
  createParamReader,
  versionHash,
} from '@osw/core';
import { trainingSlots } from '../src/training/index.js';
export const trainingNow = '2026-03-01T01:00:00Z';
export const trainingScope = { track: 'example-track', jurisdiction: 'XE', timezone: 'UTC' };
export async function trainingRecord(
  slot: string,
  id: string,
  data: unknown,
  options: Partial<AnyAssetRecord> = {},
): Promise<AnyAssetRecord> {
  return {
    slot,
    id,
    data,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions: [] },
    updatedAt: trainingNow,
    example: true,
    ...options,
  };
}
export const sampleRole = (key = 'cook', stationKey = 'hot', relief = false) => ({
  key,
  standard: 'example-food',
  onboardWave: 'first',
  ...(stationKey ? { stationKey } : {}),
  relief,
  names: { en: key },
});
export const sampleCert = (key = 'safety', extra: Record<string, unknown> = {}) => ({
  key,
  standard: 'example-food',
  title: { en: key },
  group: 'essential',
  positions: [],
  critical: true,
  locked: true,
  requires: ['written', 'practical'],
  defaultChecks: ['clean', 'serve'],
  ...extra,
});
export const sampleExam = (extra: Record<string, unknown> = {}) => ({
  key: 'example-paper',
  certKey: 'safety',
  lang: 'en',
  version: 'example-v1',
  passScore: 60,
  questions: [
    {
      no: 1,
      points: 50,
      manual: false,
      prompt: 'Invented question',
      answer: 'Example A',
      rationale: 'private rationale',
      guide: 'private guide',
    },
    { no: 2, points: 50, manual: true, prompt: 'Invented scenario', guide: 'private mark guide' },
  ],
  ...extra,
});
export const sampleCourse = () => ({
  key: 'example-course',
  rights: 'synthetic-public',
  version: 'example-v1',
  sourceDocs: [],
  units: [
    {
      id: 'hot-sop',
      title: 'Invented hot SOP',
      station: 'hot',
      positions: ['cook', 'relief'],
      critical: true,
      controls: ['observe'],
      covers: ['dish-one'],
    },
  ],
});
export const trainingParams = {
  'training.minPassScore': 60,
  'training.verify.minAttempts': 2,
  'training.verify.firstPassRateLow': 0.2,
  'training.verify.firstPassRateHigh': 0.8,
};
export async function trainingContext(
  records: AnyAssetRecord[] = [],
  params: Record<string, number> = { ...trainingParams },
): Promise<StepCtx> {
  const parameters = await Promise.all(
    Object.entries(params).map(([key, value]) => trainingRecord('params', key, { key, value })),
  );
  return {
    assets: new MemorySource([...records, ...parameters], [...SHARED_SLOTS, ...trainingSlots]),
    params: createParamReader(parameters, trainingNow),
    approvals: [],
    providers: {},
    now: trainingNow,
    actor: 'example:trainer',
  };
}
export const activeSeat = { seatId: 'seat-one', positionKey: 'cook', status: 'active' as const };
export const plannedStaffing = [{ positionKey: 'cook', planned: 1, staffed: 1 }];
export const reference = (slot = 'template', id = 'example-plan') => ({
  slot,
  id,
  versionHash: 'a'.repeat(64),
});
