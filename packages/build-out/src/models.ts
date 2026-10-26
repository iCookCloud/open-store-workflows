import {
  ArtifactEnvelope,
  AssetRef,
  BomBody,
  BuildLine,
  BuildPlanBody,
  ChangeOrder,
  ConditionKey,
  Currency,
  DeliveryPlanBody,
  FeeLine,
  IsoDate,
  LineItem,
  Measure,
  Money,
  SiteDecisionBody,
  TrackKey,
  z,
} from '@osw/core';

export const Bom = ArtifactEnvelope('Bom', BomBody);
export const SiteDecision = ArtifactEnvelope('SiteDecision', SiteDecisionBody);
export const DeliveryPlan = ArtifactEnvelope('DeliveryPlan', DeliveryPlanBody);
export const BuildPlan = ArtifactEnvelope('BuildPlan', BuildPlanBody);
export type BuildPlan = z.infer<typeof BuildPlan>;
export const ManualLine = LineItem.extend({
  name: z.string().min(1),
  category: z.string().optional(),
  basePrice: Money,
  volumePerUnit: z.number().nonnegative().optional(),
  installKind: z.enum(['loose', 'fixed', 'consumable']).optional(),
});
export const BuildOutInput = z.object({
  bom: Bom,
  site: SiteDecision,
  delivery: DeliveryPlan,
  currency: Currency,
  track: TrackKey.optional(),
  drawings: z.array(z.string().regex(/^(sha256:[0-9a-f]{64}|https:\/\/\S+)$/)).default([]),
  quantities: z.record(z.string(), z.number().nonnegative()).default({}),
  manualLines: z.array(ManualLine).default([]),
  installOverrides: z
    .record(
      z.string(),
      z.object({
        hoursPerUnit: z.number().nonnegative(),
        basis: z.string().min(1),
        trade: z.string().optional(),
      }),
    )
    .default({}),
  landlordScope: BuildPlanBody.shape.landlordScope.default([]),
  changedConditions: z.array(ConditionKey).default([]),
  options: BuildPlanBody.shape.quote.shape.options.default({
    selfInstall: false,
    selfFreight: false,
  }),
  offerIds: z.array(z.string()).default([]),
  phaseTemplateId: z.string().min(1),
  acceptanceTemplateId: z.string().min(1),
  startNotBefore: IsoDate.optional(),
  // 没有到货记录的行必须显式声明本地采购及备妥日，防止把缺货误判为本地采购。
  localAvailability: z.record(z.string(), IsoDate).default({}),
  contractor: AssetRef.optional(),
  landlord: AssetRef.optional(),
  previousPlan: BuildPlan.optional(),
  changes: z.array(ChangeOrder.omit({ status: true })).default([]),
  actuals: z
    .array(
      z.object({
        taskId: z.string(),
        ...BuildPlanBody.shape.schedule.shape.tasks.element.shape.actual.unwrap().shape,
      }),
    )
    .default([]),
  checkpoints: z
    .array(
      z.object({ key: z.string(), passedAt: IsoDate, evidenceRefs: z.array(z.string()).min(1) }),
    )
    .default([]),
  acceptance: z
    .object({
      checklist: z
        .array(
          z.object({
            key: z.string(),
            done: z.boolean(),
            evidenceRefs: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      installed: z
        .array(z.object({ lineId: z.string(), qty: z.number().nonnegative() }))
        .default([]),
      observedDeliveries: z
        .array(
          z.object({
            lineId: z.string(),
            receivedQty: z.number().nonnegative(),
            damagedQty: z.number().nonnegative(),
          }),
        )
        .default([]),
      asBuilt: z.array(z.object({ key: ConditionKey, measure: Measure })).default([]),
      punch: BuildPlanBody.shape.acceptance.shape.punch.default([]),
      landlord: z
        .array(
          z.object({ item: z.string(), delivered: z.boolean(), evidenceRefs: z.array(z.string()) }),
        )
        .default([]),
      possession: z
        .object({ observed: z.string(), evidenceRefs: z.array(z.string()).min(1) })
        .optional(),
      handover: BuildPlanBody.shape.acceptance.shape.handover.default([]),
      actualFinish: IsoDate.optional(),
    })
    .prefault({}),
});
export type BuildOutInput = z.infer<typeof BuildOutInput>;
export const DraftLine = BuildLine.omit({
  install: true,
  unitPrice: true,
  laborPerUnit: true,
  lineTotal: true,
}).extend({
  installKind: z.enum(['loose', 'fixed', 'consumable']).optional(),
  install: BuildLine.shape.install.optional(),
});
export const DraftFee = FeeLine.omit({ amount: true });
const State = z.object({ input: BuildOutInput, sources: z.array(AssetRef), example: z.boolean() });
export const Takeoff = State.extend({ lines: z.array(DraftLine), fees: z.array(DraftFee) });
export type Takeoff = z.infer<typeof Takeoff>;
export const Estimated = State.extend({
  lines: z.array(DraftLine.extend({ install: BuildLine.shape.install })),
  fees: z.array(DraftFee),
});
export type Estimated = z.infer<typeof Estimated>;
export const Quoted = State.extend({ quote: BuildPlanBody.shape.quote });
export type Quoted = z.infer<typeof Quoted>;
export const Bids = Quoted.extend({ bids: BuildPlanBody.shape.bids });
export type Bids = z.infer<typeof Bids>;
export const Scheduled = Bids.extend({ schedule: BuildPlanBody.shape.schedule });
export type Scheduled = z.infer<typeof Scheduled>;
export const Tracked = Scheduled.extend({ changes: BuildPlanBody.shape.changes });
export type Tracked = z.infer<typeof Tracked>;
