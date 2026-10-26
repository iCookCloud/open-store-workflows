import { SemVer, z } from '../base.js';
import { RecordResultSchema } from './result-schema.js';
export const SlotCapability = z.object({
  name: z.string(),
  slotVersion: SemVer,
  fieldsets: z.record(z.string(), z.array(z.string())).optional(),
  filterable: z.record(z.string(), z.array(z.string())),
  sortable: z.array(z.string()),
  count: z.boolean().optional(),
});
export const SlotsResponse = z.object({ slots: z.array(SlotCapability) });
export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), detail: z.unknown().optional() }),
});
export const ResultsResponse = z.object({ results: z.array(RecordResultSchema) });
export const OSW_VERSION = '0.1.0';
