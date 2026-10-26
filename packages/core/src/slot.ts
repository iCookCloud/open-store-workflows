import { AssetId, Coverage, Hash, IsoDateTime, SemVer, SlotName, z } from './base.js';
import { OswSourceError } from './errors.js';
import type { FilterOp } from './filter.js';
export interface SlotDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  slotVersion: string;
  schema: S;
  fieldsets?: Record<string, readonly (keyof z.infer<S> & string)[]>;
  filterable: Record<string, readonly FilterOp[]>;
  sortable: readonly string[];
  validate?: (data: z.infer<S>) => void;
}
export const AssetRecord = <T extends z.ZodType>(data: T) =>
  z.object({
    slot: SlotName,
    id: AssetId,
    slotVersion: SemVer,
    versionHash: Hash,
    fieldsetHashes: z.record(z.string(), Hash).optional(),
    coverage: Coverage,
    updatedAt: IsoDateTime,
    redacted: z.array(z.string()).optional(),
    example: z.literal(true).optional(),
    data,
  });
export type AssetRecordOf<T> = {
  slot: string;
  id: string;
  slotVersion: string;
  versionHash: string;
  fieldsetHashes?: Record<string, string>;
  coverage: z.infer<typeof Coverage>;
  updatedAt: string;
  redacted?: string[];
  example?: true;
  data: T;
};
export type AnyAssetRecord = AssetRecordOf<any>;
export function defineSlot<S extends z.ZodObject>(
  slot: Omit<SlotDef<S>, 'slotVersion' | 'filterable' | 'sortable'> & {
    slotVersion?: string;
    filterable?: Record<string, readonly FilterOp[]>;
    sortable?: readonly string[];
  },
): SlotDef<S> {
  return {
    ...slot,
    slotVersion: slot.slotVersion ?? '0.1.0',
    filterable: {
      id: ['eq', 'in'],
      'coverage.tier': ['eq', 'in'],
      'coverage.tracks': ['hasAny', 'hasAll'],
      'coverage.goodsClass': ['eq', 'in'],
      'coverage.frequency': ['eq', 'in'],
      'coverage.workflows': ['hasAny', 'hasAll'],
      'coverage.jurisdictions': ['hasAny', 'hasAll', 'exists'],
      ...slot.filterable,
    },
    sortable: [...new Set(['updatedAt', ...(slot.sortable ?? [])])],
  };
}
export function parseRecord<S extends z.ZodObject>(
  slot: SlotDef<S>,
  raw: unknown,
): AssetRecordOf<z.infer<S>> {
  const shell = AssetRecord(z.unknown()).parse(raw);
  if (shell.slot !== slot.name)
    throw new OswSourceError('slot_not_found', `Expected slot ${slot.name}`);
  if (shell.slotVersion.split('.')[0] !== slot.slotVersion.split('.')[0])
    throw new OswSourceError('slot_version_mismatch', 'Slot major version differs', {
      status: 422,
    });
  let schema: z.ZodObject = slot.schema;
  for (const hidden of shell.redacted ?? []) {
    const path = hidden
      .replace(/^\//, '')
      .replaceAll('/', '.')
      .replace(/^data\./, '')
      .split('.');
    schema = allowRedacted(schema, path);
  }
  const data = schema.parse(shell.data) as z.infer<S>;
  if (!shell.redacted?.length) slot.validate?.(data);
  if (slot.fieldsets && Object.keys(slot.fieldsets).some((k) => !shell.fieldsetHashes?.[k]))
    throw new OswSourceError('invalid_record', 'Missing fieldset hash');
  return { ...shell, data };
}
export function slotJsonSchema(slot: SlotDef): unknown {
  return z.toJSONSchema(slot.schema, { io: 'input' });
}
export function assetRef(record: AnyAssetRecord, fieldset?: string, path?: string) {
  return {
    slot: record.slot,
    id: record.id,
    versionHash: fieldset
      ? (record.fieldsetHashes?.[fieldset] ?? record.versionHash)
      : record.versionHash,
    ...(fieldset ? { fieldset } : {}),
    ...(path ? { path } : {}),
  };
}

function allowRedacted(schema: z.ZodObject, path: string[]): z.ZodObject {
  const [key, ...rest] = path;
  const field = schema.shape[key];
  if (!field) return schema;
  let replacement: z.ZodType = field;
  if (rest.length) {
    const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
    if (inner instanceof z.ZodObject) {
      replacement = allowRedacted(inner, rest);
      if (field instanceof z.ZodOptional) replacement = replacement.optional();
    }
  } else replacement = field.optional();
  return schema.safeExtend({ [key]: replacement });
}
