import { AssetRef, IsoDate, Money, OpeningRecordBody, z } from '@osw/core';

export const Marketing = OpeningRecordBody.shape.marketing;
export const LedgerRow = Marketing.shape.ledger.element;
export const LedgerEntry = LedgerRow.extend({
  status: z.enum([
    'candidate',
    'contacted',
    'agreed',
    'visited',
    'published',
    'settled',
    'todo',
    'doing',
    'done',
    'skipped',
  ]),
  paid: z.boolean().optional(),
  barterCost: Money.optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
export const CreatorFact = z.object({
  partyId: z.string().min(1),
  locality: z.object({ local: z.boolean(), by: z.string().trim().min(1) }).optional(),
  recentPostDates: z.array(IsoDate).optional(),
  audienceLanguages: z.array(z.string()).optional(),
  mixRole: z.string().optional(),
});
export type CreatorFact = z.infer<typeof CreatorFact>;
export const Candidate = z.object({
  ref: AssetRef,
  eligible: z.boolean(),
  selected: z.boolean(),
  needsReview: z.boolean(),
  mixRole: z.string().optional(),
  proven: z.boolean(),
  reason: z.enum([
    'selected',
    'locality',
    'activity',
    'engagement',
    'formatOrLanguage',
    'mix',
    'missingProfile',
  ]),
});
export type Candidate = z.infer<typeof Candidate>;
export const AssetProgress = z.object({
  key: z.string(),
  ready: z.number().int().nonnegative(),
  status: z.enum(['todo', 'doing', 'done', 'skipped']).optional(),
});
