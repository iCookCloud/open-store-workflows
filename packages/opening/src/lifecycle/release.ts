import {
  AssetId,
  AssetRef,
  IsoDate,
  type Need,
  OpeningRecordBody,
  StoreSlot,
  todayIn,
  versionHash,
  z,
} from '@osw/core';
import {
  assetRef,
  blocked,
  defineStep,
  inputNeed,
  latestApproval,
  result,
  validArtifact,
} from '../helpers.js';
import {
  Checklist,
  CurrentRelease,
  Issue,
  LIVE_STATUSES,
  Matrix,
  OpeningRecord,
  OpeningStatus,
  SignedRelease,
  Timezone,
} from './models.js';
export const ReleaseInput = z.object({
  storeId: AssetId,
  checklist: Checklist,
  matrix: Matrix.nullable(),
  issues: z.array(Issue),
  timezone: Timezone,
});
export function releaseState(
  input: z.infer<typeof ReleaseInput>,
  now: string,
): z.infer<typeof CurrentRelease> {
  const blockers: z.infer<typeof CurrentRelease>['blockers'] = [];
  for (const item of input.checklist.items)
    if (item.gate && !['done', 'skipped'].includes(item.status))
      blockers.push({ kind: 'checklist', ref: item.key, waivable: item.waivable });
  for (const issue of input.issues)
    if (issue.severity === 'P0' && issue.status !== 'closed')
      blockers.push({ kind: 'issueP0', ref: issue.id, waivable: false });
  if (!input.matrix) blockers.push({ kind: 'trainingMissing', ref: 'training', waivable: false });
  else {
    const active = new Set(
      input.matrix.seats.filter((seat) => seat.status === 'active').map((seat) => seat.seatId),
    );
    if (input.matrix.summary.planTotal <= 0 || input.matrix.summary.gaps.length)
      blockers.push({ kind: 'trainingMissing', ref: 'staffingGaps', waivable: false });
    if (!active.size) blockers.push({ kind: 'hollow', ref: 'staffing', waivable: false });
    const required = input.matrix.cells.filter((cell) => active.has(cell.seatId) && cell.critical);
    if (!required.length)
      blockers.push({ kind: 'trainingMissing', ref: 'criticalRequirements', waivable: false });
    const today = todayIn(input.timezone, now);
    for (const cell of required)
      if (cell.state !== 'passed' || (cell.recertDue && cell.recertDue <= today))
        blockers.push({
          kind: 'criticalCert',
          ref: `${cell.seatId}|${cell.certKey}`,
          waivable: !cell.locked,
        });
  }
  // 阻断集合稳定排序；花名册或清单显示顺序变化不应使同一审批失效。
  blockers.sort((a, b) =>
    `${a.kind}:${a.ref}` < `${b.kind}:${b.ref}`
      ? -1
      : `${a.kind}:${a.ref}` > `${b.kind}:${b.ref}`
        ? 1
        : 0,
  );
  return {
    state: !blockers.length
      ? 'ready'
      : blockers.every((blocker) => blocker.waivable)
        ? 'conditional'
        : 'blocked',
    blockers,
  };
}
export const evaluateRelease = defineStep({
  id: 'opening/evaluateRelease',
  input: ReleaseInput,
  output: CurrentRelease,
  reads: [],
  params: [],
  async run(input, ctx) {
    return result(releaseState(input, ctx.now));
  },
});
export const SignReleaseInput = ReleaseInput.extend({ previous: OpeningRecord.optional() });
export const ReleaseOutput = z.object({
  release: OpeningRecordBody.shape.release,
  decidedAt: OpeningRecordBody.shape.decidedAt,
});
export async function frozenRelease(
  previous: z.infer<typeof OpeningRecord>,
  storeId: string,
  now: string,
): Promise<Need[]> {
  const needs = await validArtifact(previous, 'previous.hash');
  const signed = previous.body.release.signed;
  if (previous.storeId !== storeId)
    needs.push(inputNeed('previous.storeId', 'OpeningRecord belongs to another store'));
  if (
    !signed ||
    signed.decision === 'no_go' ||
    signed.at !== previous.body.decidedAt ||
    Date.parse(signed.at) > Date.parse(now)
  )
    needs.push(
      inputNeed('previous.release', 'A live record requires its original effective go signature'),
    );
  else if (
    (await versionHash(signed.snapshot)) !== signed.snapshotHash ||
    (signed.decision === 'go' && signed.snapshot.length > 0) ||
    (signed.decision === 'go_with_conditions' &&
      (!signed.snapshot.length || signed.snapshot.some((b) => !b.waivable)))
  )
    needs.push(inputNeed('previous.release', 'Frozen release signature is inconsistent'));
  return needs;
}
export const signRelease = defineStep({
  id: 'opening/signRelease',
  input: SignReleaseInput,
  output: ReleaseOutput,
  reads: [],
  params: [],
  approval: {
    question: 'Sign the current opening blockers?',
    decision: z.enum(['go', 'go_with_conditions', 'no_go']),
  },
  async run(input, ctx) {
    const current = releaseState(input, ctx.now);
    if (input.previous && LIVE_STATUSES.has(input.previous.body.status)) {
      const needs = await frozenRelease(input.previous, input.storeId, ctx.now);
      return result(
        {
          release: { current, signed: input.previous.body.release.signed },
          decidedAt: input.previous.body.decidedAt,
        },
        needs,
      );
    }
    const hash = await versionHash(current.blockers);
    const subject = `store:${input.storeId}`;
    const need = {
      kind: 'approval' as const,
      step: 'opening/signRelease',
      subject,
      subjectHash: hash,
      question: 'Sign this store opening decision against the current blockers',
      blocking: true,
    };
    const approval = latestApproval(ctx, 'opening/signRelease', hash, subject);
    if (!approval) return blocked([need]);
    const decision = z.enum(['go', 'go_with_conditions', 'no_go']).safeParse(approval.decision);
    if (!decision.success)
      return blocked([need, inputNeed('approval.decision', 'Unsupported opening decision')]);
    if (decision.data === 'go' && current.state !== 'ready')
      return blocked([inputNeed('approval.decision', 'go requires no blockers')]);
    if (decision.data === 'go_with_conditions') {
      if (current.state !== 'conditional')
        return blocked([
          inputNeed('approval.decision', 'Conditional release requires only waivable blockers'),
        ]);
      if (
        !approval.note?.trim() ||
        current.blockers.some(
          (blocker) =>
            !approval.conditions?.some(
              (condition) =>
                condition.ref === blocker.ref &&
                condition.text.trim() &&
                condition.dueDate >= todayIn(input.timezone, approval.at),
            ),
        )
      )
        return blocked([
          inputNeed(
            'approval.conditions',
            'Every blocker needs a condition, due date and release note',
          ),
        ]);
    }
    if (decision.data === 'no_go' && !approval.note?.trim())
      return blocked([inputNeed('approval.note', 'no_go requires a reason')]);
    const signed = {
      snapshot: current.blockers,
      snapshotHash: hash,
      decision: decision.data,
      at: approval.at,
      by: approval.by,
    };
    return result({
      release: { current, signed },
      decidedAt: decision.data === 'no_go' ? null : approval.at,
    });
  },
});
const transitions: Record<
  z.infer<typeof OpeningStatus>,
  readonly z.infer<typeof OpeningStatus>[]
> = {
  planning: ['soft_opening', 'ready'],
  soft_opening: ['planning', 'ready'],
  ready: ['planning', 'soft_opening', 'live'],
  live: ['ready', 'stabilizing'],
  stabilizing: ['live', 'completed'],
  completed: ['stabilizing'],
};
export const TransitionInput = SignReleaseInput.extend({ from: OpeningStatus, to: OpeningStatus });
export const transition = defineStep({
  id: 'opening/transition',
  input: TransitionInput,
  output: z.object({
    status: OpeningStatus,
    release: OpeningRecordBody.shape.release,
    decidedAt: OpeningRecordBody.shape.decidedAt,
  }),
  reads: [],
  params: [],
  async run(input, ctx) {
    if (input.from !== input.to && !transitions[input.from].includes(input.to))
      return blocked([inputNeed('to', `Invalid opening transition ${input.from} → ${input.to}`)]);
    if (
      LIVE_STATUSES.has(input.from) &&
      (!input.previous || input.previous.body.status !== input.from)
    )
      return blocked([
        inputNeed('previous', 'Live transitions require the previous OpeningRecord'),
      ]);
    const signed = await signRelease.run(input, ctx);
    if (!signed.output) return blocked(signed.needs, signed.verifications);
    if (
      LIVE_STATUSES.has(input.to) &&
      (signed.output.release.signed?.decision === 'no_go' || !signed.output.decidedAt)
    )
      return blocked([inputNeed('to', 'A valid go release is required to open')]);
    return result({ status: input.to, ...signed.output }, signed.needs);
  },
});
export const HandoffInput = z.object({ record: OpeningRecord, openedAt: IsoDate.optional() });
export const handoff = defineStep({
  id: 'opening/handoff',
  input: HandoffInput,
  output: z.object({ handoff: OpeningRecordBody.shape.handoff, storeRef: AssetRef }),
  reads: ['store'],
  params: [],
  approval: { question: 'Confirm this store is operating?', decision: z.literal('operating') },
  async run(input, ctx) {
    const record = input.record;
    if (!record.storeId || !LIVE_STATUSES.has(record.body.status))
      return blocked([inputNeed('record', 'An operating stage and storeId are required')]);
    const needs = await frozenRelease(record, record.storeId, ctx.now);
    if (needs.length) return blocked(needs);
    const store = await ctx.assets.get(StoreSlot, record.storeId);
    if (!store)
      return blocked([
        {
          kind: 'asset',
          slot: 'store',
          filter: { field: 'id', op: 'eq', value: record.storeId },
          reason: 'Store asset is required for handoff',
          blocking: true,
        },
      ]);
    if (
      store.data.status === 'closed' ||
      store.data.track !== record.body.track ||
      store.data.jurisdiction !== record.body.jurisdiction ||
      store.data.timezone !== record.body.timezone
    )
      return blocked([
        inputNeed('store', 'Store identity or operating status conflicts with the opening record'),
      ]);
    const openedAt =
      store.data.openedAt ??
      record.body.handoff?.openedAt ??
      input.openedAt ??
      record.body.openingDate;
    if (openedAt > todayIn(record.body.timezone, ctx.now))
      return blocked([inputNeed('openedAt', 'A future date cannot confirm an operating store')]);
    if (record.body.handoff && input.openedAt && input.openedAt !== record.body.handoff.openedAt)
      return blocked([inputNeed('openedAt', 'The first opening date is immutable')]);
    const hash = await versionHash({ storeId: record.storeId, openedAt });
    const approval = latestApproval(ctx, 'opening/handoff', hash);
    if (
      !record.body.handoff &&
      (!approval || approval.decision !== 'operating' || !approval.note?.trim())
    )
      return blocked([
        {
          kind: 'approval',
          step: 'opening/handoff',
          subjectHash: hash,
          question: 'Confirm operating status with a nonempty note',
          blocking: true,
        },
      ]);
    const ref = assetRef(store);
    return {
      ...result({ handoff: { storeStatus: 'operating' as const, openedAt }, storeRef: ref }),
      fills: [{ asset: ref, field: 'openedAt', value: openedAt, by: ctx.actor, at: ctx.now }],
    };
  },
});
