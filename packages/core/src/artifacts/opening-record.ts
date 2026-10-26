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
const Readiness = z.object({
  planTotal: Count,
  staffed: Count,
  gaps: z.array(z.object({ position: z.string(), plan: Count, actual: Count })),
  certRequired: Count,
  certPassed: Count,
  criticalRequired: Count,
  criticalPassed: Count,
  criticalPending: Count,
  expiring: Count,
  hollow: z.boolean(),
  ready: z.boolean(),
});
const MarketingItem = z.object({
  key: z.string(),
  channel: z.string(),
  title: z.string(),
  dayOffset: z.number().int(),
  dueDate: IsoDate,
  deliverable: z.string(),
  core: z.boolean(),
  status: z.enum(['todo', 'doing', 'done', 'skipped']),
});
const LedgerRow = z.object({
  id: z.string(),
  channel: z.string(),
  status: z.string(),
  spend: Money,
  visits: Count,
  evidence: z.array(z.string()),
  creatorRef: AssetRef.optional(),
  disclosureEvidence: z.string().optional(),
});
const AssetGap = z.object({
  required: Count,
  ready: Count,
  missing: Count,
  blockedChannels: z.array(z.string()),
});
const Kpis = z.object({
  orders: Count,
  revenue: Money,
  labor: Money.nullable(),
  foodCost: Money.nullable(),
  waste: Money.nullable(),
  averageTicket: Money.nullable(),
  primeCostRate: z.number().nullable(),
});
const CostAction = z.object({
  baseline: z.string().min(1),
  action: z.string().min(1),
  expected: z.string().min(1),
  actual: z.string(),
  decision: z.enum(['keep', 'revert', 'adjust', 'pending']),
});
const Lesson = z.object({
  lesson: z.string().min(1),
  verdict: z.enum(['reuse', 'as_reference', 'do_not_repeat']),
  condition: z.string().min(1),
});
const CellState = z.enum(['pending', 'grading', 'passed', 'failed', 'expired']);
const Blocker = z.object({
  kind: z.enum(['checklist', 'issueP0', 'trainingMissing', 'hollow', 'criticalCert']),
  ref: z.string(),
  waivable: z.boolean(),
});
export const OpeningRecordBody = z.object({
  menuRef: AssetRef,
  bomRef: ArtifactRef,
  decidedAt: IsoDateTime.nullable(),
  track: TrackKey,
  jurisdiction: Jurisdiction,
  timezone: z.string(),
  openingDate: IsoDate,
  softOpeningDate: IsoDate.optional(),
  status: z.enum(['planning', 'soft_opening', 'ready', 'live', 'stabilizing', 'completed']),
  staffing: z.array(
    z.object({ positionKey: z.string(), planned: z.number().int(), staffed: z.number().int() }),
  ),
  certMatrix: z.object({
    plan: AssetRef,
    seats: z.array(
      z.object({
        seatId: z.string(),
        positionKey: z.string(),
        status: z.enum(['planned', 'active', 'left']),
      }),
    ),
    cells: z.array(
      z.object({
        seatId: z.string(),
        certKey: z.string(),
        critical: z.boolean(),
        locked: z.boolean(),
        state: CellState,
        passedAt: IsoDate.optional(),
        recertDue: IsoDate.optional(),
        sop: AssetRef.optional(),
        examiner: z.string().optional(),
        attempts: z.number().int(),
      }),
    ),
    summary: Readiness,
  }),
  checklist: z.object({
    template: AssetRef,
    firstDay: z.number().int(),
    lastDay: z.number().int(),
    items: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        phase: z.string(),
        dayOffset: z.number().int(),
        dueDate: IsoDate,
        gate: z.boolean(),
        waivable: z.boolean(),
        status: z.enum(['todo', 'doing', 'done', 'skipped']),
        note: z.string(),
      }),
    ),
  }),
  issues: z.array(
    z.object({
      id: z.string(),
      area: z.string(),
      severity: z.enum(['P0', 'P1', 'P2']),
      status: z.enum(['open', 'fixing', 'verifying', 'closed']),
      refs: z.array(AssetRef),
      openedOn: IsoDate,
      closedOn: IsoDate.optional(),
      verificationNote: z.string().optional(),
    }),
  ),
  release: z.object({
    current: z.object({
      state: z.enum(['ready', 'conditional', 'blocked']),
      blockers: z.array(Blocker),
    }),
    signed: z
      .object({
        snapshot: z.array(Blocker),
        snapshotHash: Hash,
        decision: z.enum(['go', 'go_with_conditions', 'no_go']),
        at: IsoDateTime,
        by: z.string(),
      })
      .nullable(),
  }),
  marketing: z.object({
    template: AssetRef,
    items: z.array(MarketingItem),
    ledger: z.array(LedgerRow),
    assetGap: AssetGap,
  }),
  reviews: z.array(
    z.object({
      checkpoint: z.string(),
      kpis: Kpis,
      costActions: z.array(CostAction),
      lessons: z.array(Lesson),
      signedAt: IsoDateTime.nullable(),
    }),
  ),
  handoff: z.object({ storeStatus: z.literal('operating'), openedAt: IsoDate }).nullable(),
});
