import { LocalizedText, defineSlot, z } from '@osw/core';
export const AssessmentKind = z.enum(['written', 'practical', 'scenario']);
export const Cert = z.object({
  key: z.string().min(1),
  standard: z.string().min(1),
  title: LocalizedText,
  group: z.string(),
  positions: z.array(z.string()),
  critical: z.boolean(),
  locked: z.boolean(),
  requires: z.array(AssessmentKind),
  recertMonths: z.number().int().positive().optional(),
  supersededBy: z.array(z.string()).optional(),
  noWritten: z
    .object({ kind: z.string(), why: z.string().min(1), by: z.array(z.string()).min(1) })
    .optional(),
  defaultChecks: z.array(z.string().min(1)),
  stationKey: z.string().min(1).optional(),
});
export const CertSlot = defineSlot({
  name: 'cert',
  schema: Cert,
  filterable: {
    key: ['eq', 'in'],
    standard: ['eq', 'in'],
    positions: ['hasAny'],
    group: ['eq', 'in'],
  },
  sortable: ['key', 'group'],
});
