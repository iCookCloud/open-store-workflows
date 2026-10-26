import {
  Address,
  AssetId,
  AssetRef,
  FillSrc,
  GeoPoint,
  Hash,
  IsoDate,
  IsoDateTime,
  Jurisdiction,
  LineItem,
  Measure,
  Money,
  ParamKey,
  TrackKey,
  Unit,
  z,
} from '../base.js';
import { BudgetKey } from '../budget.js';
import { ConditionKey, ConditionReading, Requirement } from '../conditions.js';
import { FilterSchema } from '../filter.js';
import { ArtifactRef } from './envelope.js';

const Count = z.number().int().nonnegative();
const Axis = z.array(z.string()).min(1).optional();
export const AudienceRule = z.object({ tracks: Axis, regions: Axis, categories: Axis }).strict();
export const StoreSegment = z.object({
  key: z.string(),
  region: Jurisdiction,
  track: TrackKey,
  supplyCats: z.array(z.string()),
  count: Count,
  filter: FilterSchema,
});
export const SupplierMatch = z.object({
  supplierId: z.string(),
  offerIds: z.array(z.string()),
  segments: z.array(z.object({ key: z.string(), count: Count, sharedCats: z.array(z.string()) })),
  blocked: z.object({ region: Count, cats: Count, track: Count }),
});
export const CampaignVariant = z.object({
  variantKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  cell: z.record(z.string(), z.string()),
  rule: AudienceRule,
  lead: AssetRef,
  service: AssetRef,
  productIds: z.array(z.string()).min(1),
  subject: z.string().max(200),
  preheader: z.string(),
  expected: Count,
});
export const Campaign = z.object({
  campaignId: z.string(),
  sourceRef: z.string().optional(),
  supplierId: z.string(),
  topicKey: z.string(),
  topicRule: AudienceRule,
  dims: z.array(z.string()).min(1).max(3),
  variants: z.array(CampaignVariant).min(1),
  sharedBlocks: z.array(AssetRef),
  contentHash: Hash,
  breakerFrom: z.string().optional(),
  state: z.enum(['draft', 'approved', 'sending', 'held', 'paused', 'done']),
  stats: z
    .record(
      z.enum(['sent', 'failed', 'queued', 'bounced', 'complained', 'unsub', 'replies', 'orders']),
      Count,
    )
    .optional(),
});
export const SupplyProgramBody = z.object({
  ruleset: AssetRef,
  segmentation: z.object({
    total: Count,
    segments: z.array(StoreSegment),
    unclassified: z.object({
      count: Count,
      byMissing: z.record(z.string(), Count),
      sample: z.array(z.string()),
    }),
  }),
  matches: z.array(SupplierMatch),
  campaigns: z.array(Campaign),
  reorders: z.object({
    byState: z.record(z.string(), Count),
    attributed: Count,
    cursor: z.string().optional(),
  }),
  replenishShare: z.array(
    z.object({
      segmentKey: z.string(),
      basis: z.enum(['bom', 'none']),
      stores: Count,
      byLines: z.number().min(0).max(1).nullable(),
      target: z.number(),
    }),
  ),
});
