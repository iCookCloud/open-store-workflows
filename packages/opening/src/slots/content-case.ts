import { defineSlot, z } from '@osw/core';

export const ContentCase = z.object({
  goal: z.string().min(1),
  durationSec: z.number().positive(),
  metrics: z.object({
    plays: z.number().int().nonnegative(),
    likes: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative().optional(),
    shares: z.number().int().nonnegative().optional(),
  }),
  url: z.url(),
});
export const contentCaseSlot = defineSlot({
  name: 'content-case',
  schema: ContentCase,
  filterable: { goal: ['eq', 'in'], durationSec: ['gte', 'lte'] },
  sortable: ['durationSec'],
});
