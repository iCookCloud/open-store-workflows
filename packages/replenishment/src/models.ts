import { AssetId, IsoDateTime, Jurisdiction, SupplyProgramBody, TrackKey, z } from '@osw/core';

export const SegmentRuleset = z
  .object({
    segmentRegions: z.array(Jurisdiction).min(1),
    regionTiers: z.record(z.string(), z.array(Jurisdiction)),
    supplyCats: z.array(z.string()),
    trackSupply: z.record(TrackKey, z.array(z.string())),
    categoryAliases: z.record(z.string(), TrackKey),
  })
  .refine(
    (r) =>
      Object.values(r.trackSupply)
        .flat()
        .every((cat) => r.supplyCats.includes(cat)),
    'Unknown supply category',
  );
export type SegmentRuleset = z.infer<typeof SegmentRuleset>;
export const StoreContact = z.object({
  storeId: AssetId,
  channel: z.enum(['email']),
  address: z.string().min(1),
  verdict: z.enum(['valid', 'verified', 'pending', 'typo', 'issue', 'invalid', 'optout']),
  source: z.string().min(1),
  verifiedAt: IsoDateTime,
  createdAt: IsoDateTime.optional(),
  categoryRaw: z.string().optional(),
  optout: z.boolean().optional(),
});
export type StoreContact = z.infer<typeof StoreContact>;
export const Suppression = z.object({
  address: z.string().min(1),
  reason: z.enum(['optout', 'bounce', 'complaint', 'invalid']),
  at: IsoDateTime,
});
export type Suppression = z.infer<typeof Suppression>;
export const SendEvent = z.enum([
  'none',
  'delivered',
  'soft_bounced',
  'bounced',
  'complained',
  'opened',
  'clicked',
  'unsub',
]);
export const SendLog = z.object({
  campaignId: z.string().min(1),
  topicKey: z.string().min(1),
  variantKey: z.string().min(1),
  contactId: AssetId,
  status: z.enum(['queued', 'sent', 'failed']),
  event: SendEvent,
  providerId: z.string().optional(),
  at: IsoDateTime,
  eventAt: IsoDateTime.optional(),
  error: z.string().optional(),
});
export type SendLog = z.infer<typeof SendLog>;
export const Reply = z.object({
  sendId: z.string().optional(),
  contactId: AssetId,
  kind: z.enum([
    'unclassified',
    'interested',
    'order',
    'question',
    'negative',
    'closed',
    'unsubscribe',
  ]),
  receivedAt: IsoDateTime,
});
export type Reply = z.infer<typeof Reply>;
export const SendIntent = z.object({
  contactId: AssetId,
  storeId: AssetId,
  variantKey: z.string(),
});
export type SendIntent = z.infer<typeof SendIntent>;
export const Segmentation = SupplyProgramBody.shape.segmentation;
export type Segmentation = z.infer<typeof Segmentation>;
