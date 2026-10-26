import { Jurisdiction, z } from '@osw/core';
export const ChecklistTemplateItem = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  phase: z.string(),
  dayOffset: z.number().int(),
  gate: z.boolean().default(false),
  waivable: z.boolean().default(false),
  jurisdiction: Jurisdiction.optional(),
  ownerRole: z.string().optional(),
  reviewCheckpoint: z.string().optional(),
  crossRole: z.boolean().optional(),
  upstream: z.enum(['acceptance', 'openingStock', 'fitoutGoods']).optional(),
});
export const OpeningChecklistContent = z
  .object({
    items: z.array(ChecklistTemplateItem).min(1),
    complaintAreas: z.array(z.string()),
  })
  .refine(
    (value) => new Set(value.items.map((item) => item.key)).size === value.items.length,
    'Checklist keys must be unique',
  );
