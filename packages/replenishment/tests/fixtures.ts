import {
  type AnyAssetRecord,
  MemorySource,
  SHARED_SLOTS,
  type SlotDef,
  type StepCtx,
  createParamReader,
  fieldsetHash,
  versionHash,
} from '@osw/core';
import { campaignSlots } from '../src/slots.js';

export const NOW = '2026-02-02T12:00:00Z';
export const ACTOR = 'example:operator';
export async function record(
  slot: string,
  id: string,
  data: unknown,
  options: {
    frequency?: 'opening' | 'recurring';
    updatedAt?: string;
    slots?: readonly SlotDef[];
  } = {},
): Promise<AnyAssetRecord> {
  const definition = [...SHARED_SLOTS, ...campaignSlots, ...(options.slots ?? [])].find(
    (entry) => entry.name === slot,
  );
  const fields = Object.fromEntries(
    await Promise.all(
      Object.entries(definition?.fieldsets ?? {}).map(async ([key, keys]) => [
        key,
        await fieldsetHash(data as Record<string, unknown>, keys),
      ]),
    ),
  );
  return {
    slot,
    id,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    ...(Object.keys(fields).length ? { fieldsetHashes: fields } : {}),
    coverage: {
      tier: 'general',
      tracks: [],
      workflows: ['replenishment'],
      jurisdictions: ['XE'],
      ...(options.frequency ? { frequency: options.frequency } : {}),
    },
    updatedAt: options.updatedAt ?? NOW,
    example: true,
    data,
  };
}
export function context(
  records: AnyAssetRecord[] = [],
  params: Record<string, number | string | boolean> = {},
  slots: readonly SlotDef[] = [],
): StepCtx {
  const reader = createParamReader(
    records.filter((entry) => entry.slot === 'params'),
    NOW,
  );
  return {
    assets: new MemorySource(records, [...campaignSlots, ...slots]),
    params: {
      ...reader,
      get: (key, scope) => (key in params ? { value: params[key] } : reader.get(key, scope)),
    },
    approvals: [],
    providers: {},
    now: NOW,
    actor: ACTOR,
  };
}
