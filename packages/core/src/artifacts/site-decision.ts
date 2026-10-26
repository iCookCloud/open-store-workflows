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

export const ConditionCheck = ConditionReading.extend({
  required: Requirement.optional(),
  claimed: Measure.optional(),
  verdict: z.enum(['holds', 'fails', 'waived']),
});
export const SiteDecisionRent = z
  .object({
    base: Money,
    period: z.enum(['month', 'year']),
    basis: z.enum(['total', 'per_area']),
    areaUnit: z.enum(['ft2', 'm2']).optional(),
    escalation: z
      .object({
        kind: z.enum(['none', 'fixed_pct', 'fixed_amount', 'index']),
        value: z.number().nullable(),
        everyMonths: z.number().int().positive(),
      })
      .strict(),
    freeRentMonths: z.number().min(0),
    additional: z.array(
      z
        .object({
          kind: z.enum(['cam', 'tax', 'insurance', 'nnn', 'utilities', 'other']),
          estimate: Money.nullable(),
          period: z.enum(['month', 'year']),
          capPct: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.basis === 'per_area' && !v.areaUnit)
      ctx.addIssue({
        code: 'custom',
        message: 'Per-area rent requires areaUnit',
        path: ['areaUnit'],
      });
  });
const Lease = z
  .object({
    termMonths: z.number().int().positive(),
    renewals: z.array(
      z.object({ months: z.number().int().positive(), rentRule: z.string() }).strict(),
    ),
    possessionDate: IsoDate.nullable(),
    rentCommencementDate: IsoDate.nullable(),
    rent: SiteDecisionRent,
    deposit: Money.nullable(),
    tiAllowance: Money.nullable(),
    guarantee: z
      .object({
        kind: z.enum(['none', 'personal', 'good_guy', 'corporate']),
        cap: Money.nullable(),
      })
      .strict(),
    permittedUse: z.string().min(1),
    exclusiveUse: z.boolean(),
    assignment: z.enum(['allowed', 'consent', 'prohibited']),
    deliveryCondition: z.enum(['shell', 'vanilla_box', 'second_gen_food', 'as_is', 'turnkey']),
    landlordWork: z.array(z.string()),
    documents: z.array(
      z
        .object({
          template: AssetRef,
          kind: z.enum(['loi', 'lease', 'rider', 'guarantee', 'sublease']),
          contentHash: z.string().regex(/^[0-9a-f]{64}$/),
          signedAt: IsoDateTime.nullable(),
          envelopeRef: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export const SiteDecisionBody = z
  .object({
    stage: z.enum(['chosen', 'loi', 'signed']),
    listing: AssetRef,
    address: Address,
    geo: GeoPoint,
    jurisdiction: Jurisdiction,
    unit: z.string(),
    floorLevel: z.number().int(),
    conditions: z.array(ConditionCheck).min(1),
    unmeasured: z.array(Requirement),
    openingTarget: IsoDate,
    lease: Lease.nullable(),
    shortlist: z.array(
      z
        .object({
          listing: AssetRef,
          status: z.enum(['shortlisted', 'visited', 'rejected', 'chosen']),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((v, ctx) => {
    const chosen = v.shortlist.filter((s) => s.status === 'chosen');
    if (
      chosen.length !== 1 ||
      chosen[0].listing.id !== v.listing.id ||
      chosen[0].listing.slot !== v.listing.slot ||
      chosen[0].listing.versionHash !== v.listing.versionHash
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Shortlist must choose exactly the selected listing',
        path: ['shortlist'],
      });
    if (v.stage === 'chosen') return;
    if (!v.lease)
      ctx.addIssue({
        code: 'custom',
        message: 'Lease required after chosen stage',
        path: ['lease'],
      });
    for (const key of [
      'area',
      'frontage',
      'clearHeight',
      'powerCapacity',
      'gasService',
      'exhaustPath',
    ])
      if (!v.conditions.some((c) => c.key === key))
        ctx.addIssue({
          code: 'custom',
          message: `Missing surveyed condition ${key}`,
          path: ['conditions'],
        });
    if (v.stage === 'signed') {
      if (v.unmeasured.some((r) => r.hard))
        ctx.addIssue({
          code: 'custom',
          message: 'Signed lease has unmeasured hard conditions',
          path: ['unmeasured'],
        });
      if (
        v.lease?.documents.some(
          (d) => ['lease', 'rider', 'guarantee'].includes(d.kind) && !d.signedAt,
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Lease documents must be signed',
          path: ['lease', 'documents'],
        });
    }
  });
