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
const ChecklistItem = z.object({
  key: z.string(),
  title: z.string(),
  ownerRole: z.string(),
  dependsOn: z.array(z.string()),
  evidence: z.string(),
  gate: z.boolean(),
});
const Verdict = z.enum(['holds', 'fails', 'pending']);
export const BuildLine = LineItem.extend({
  source: z.enum(['bom', 'manual']),
  bomLineId: z.string().optional(),
  bomQty: z.number().nonnegative().optional(),
  name: z.string(),
  category: z.string().optional(),
  trade: z.string().optional(),
  basePrice: Money,
  install: z.object({
    hoursPerUnit: z.number().nonnegative(),
    basis: z.string(),
    rateRef: AssetRef.optional(),
    overridden: z.boolean(),
  }),
  volumePerUnit: z.number().nonnegative().optional(),
  partsCheck: z.enum(['holds', 'fails', 'absent']).optional(),
  unitPrice: Money,
  laborPerUnit: Money,
  lineTotal: Money,
});
export const FeeLine = z.object({
  id: z.string(),
  name: z.string(),
  basis: z.enum(['pctOfGoods', 'fixed', 'perVolume']),
  pct: z.number().nonnegative().optional(),
  rate: Money.optional(),
  freight: z.boolean(),
  ruleRef: AssetRef.optional(),
  fromDelivery: z.boolean(),
  amount: Money,
});
export const BuildTask = z.object({
  id: z.string(),
  name: z.string(),
  phase: z.string(),
  trade: z.string().optional(),
  lineIds: z.array(z.string()),
  dependsOn: z.array(z.string()),
  checkpoint: z.string().optional(),
  workHours: z.number().nonnegative(),
  durationDays: z.number().int().nonnegative(),
  earliestStart: IsoDate,
  start: IsoDate,
  end: IsoDate,
  slackDays: z.number().int(),
  critical: z.boolean(),
  actual: z
    .object({
      start: IsoDate,
      end: IsoDate.optional(),
      hours: z.number().nonnegative(),
      by: z.string(),
    })
    .optional(),
});
export const ChangeOrder = z.object({
  id: z.string(),
  reason: z.string(),
  lineDeltas: z.array(z.object({ lineId: z.string(), qtyDelta: z.number() })),
  priceDelta: Money,
  scheduleDeltaDays: z.number().int(),
  status: z.enum(['proposed', 'effective']),
});
export const BuildPlanBody = z.object({
  drawings: z.array(z.string()),
  landlordScope: z.array(
    z.object({ item: z.string(), lineIds: z.array(z.string()), conditions: z.array(ConditionKey) }),
  ),
  quote: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    lines: z.array(BuildLine),
    fees: z.array(FeeLine),
    laborRate: Money,
    fxUsed: z.record(ParamKey, z.number().positive()),
    options: z.object({ selfInstall: z.boolean(), selfFreight: z.boolean() }),
    totals: z.object({
      goods: Money,
      labor: Money,
      fees: Money,
      total: Money,
      laborHours: z.number(),
    }),
    status: z.enum(['draft', 'issued', 'accepted', 'declined']),
    quoteHash: Hash,
    acceptedAt: IsoDateTime.optional(),
  }),
  bids: z
    .array(
      z.object({
        partyId: z.string(),
        offerRefs: z.array(AssetRef),
        total: Money,
        missingLineIds: z.array(z.string()),
        hours: z.number().optional(),
      }),
    )
    .default([]),
  schedule: z.object({
    start: IsoDate,
    finish: IsoDate,
    tasks: z.array(BuildTask),
    criticalPath: z.array(z.string()),
    blocked: z.array(
      z.object({ lineId: z.string(), reason: z.enum(['no-eta', 'damaged', 'short']) }),
    ),
  }),
  changes: z.array(ChangeOrder),
  acceptance: z.object({
    status: z.enum(['open', 'conditional', 'accepted', 'rejected']),
    acceptedAt: IsoDateTime.optional(),
    checklist: z.array(
      ChecklistItem.extend({ done: z.boolean(), evidenceRefs: z.array(z.string()) }),
    ),
    lineChecks: z.array(
      z.object({
        lineId: z.string(),
        expectedQty: z.number(),
        deliveredQty: z.number().nullable(),
        damagedQty: z.number().default(0),
        installedQty: z.number(),
        verdict: Verdict,
        note: z.string().optional(),
      }),
    ),
    siteChecks: z.array(
      z.object({
        key: ConditionKey,
        inScope: z.boolean(),
        required: Requirement.optional(),
        measure: Measure,
        asBuilt: Measure,
        verdict: Verdict,
      }),
    ),
    punch: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        severity: z.enum(['blocking', 'minor']),
        owner: z.string(),
        due: IsoDate.optional(),
        closedAt: IsoDate.optional(),
      }),
    ),
    landlordChecks: z.array(
      z.object({
        item: z.string(),
        delivered: z.boolean(),
        verdict: Verdict,
        evidenceRefs: z.array(z.string()),
      }),
    ),
    possession: z
      .object({ promised: z.string(), observed: z.string(), verdict: Verdict })
      .optional(),
    handover: z.array(
      z.object({
        kind: z.enum(['as-built', 'om-manual', 'warranty', 'permit-signoff', 'other']),
        ref: z.string(),
      }),
    ),
  }),
});
