import {
  ArtifactRef,
  type AssetRecordOf,
  AssetRef,
  type AssetRef as AssetReference,
  IsoDate,
  Lang,
  type Need,
  OpeningRecordBody,
  SHARED_SLOTS,
  type SlotDef,
  type StepCtx,
  type StepDef,
  type StepResult,
  type WorkflowModule,
  versionHash,
  z,
} from '@osw/core';
import { inputNeed, parseNeeds, uniqueRefs, validArtifact } from './helpers.js';
import { ExpandChecklistInput, expandChecklist, reschedule } from './lifecycle/checklist.js';
import { importUpstreamIssues } from './lifecycle/issues.js';
import {
  BuildPlan,
  DeliveryPlan,
  Issue,
  LIVE_STATUSES,
  Matrix,
  OpeningRecord,
  OpeningStatus,
  StoreSpec,
  artifactRef,
} from './lifecycle/models.js';
import { evaluateRelease, handoff, signRelease, transition } from './lifecycle/release.js';
import { ReviewObservation, review } from './lifecycle/review.js';
import {
  PlanMarketingInput,
  marketingSlots,
  marketingSteps,
  planMarketing,
} from './marketing/index.js';
import {
  Cell,
  ExamAttempt,
  ExamSubmission,
  PlanItem,
  Seat,
  applyExam,
  buildCertPlan,
  checkSopCoverage,
  deriveCertMatrix,
  pickMaterials,
  planStaffing,
  readiness,
  trainingSlots,
  trainingSteps,
} from './training/index.js';

export const OpeningInput = z.object({
  storeSpec: StoreSpec,
  bomRef: ArtifactRef,
  openingDate: IsoDate,
  softOpeningDate: IsoDate.optional(),
  languages: z.array(Lang).min(1),
  seats: z.array(Seat),
  planTemplateRef: AssetRef.optional(),
  planItems: z.array(PlanItem).optional(),
  cells: z.array(Cell).optional(),
  examHistory: z.array(ExamAttempt).default([]),
  assessments: z
    .array(
      z.object({
        seatId: z.string(),
        certKey: z.string(),
        examRef: AssetRef.optional(),
        submission: ExamSubmission,
      }),
    )
    .default([]),
  checklistTemplateRef: AssetRef.optional(),
  checklistUpdates: ExpandChecklistInput.shape.updates,
  issues: z.array(Issue).default([]),
  issueUpdates: z.array(Issue).default([]),
  buildPlan: BuildPlan.optional(),
  deliveryPlan: DeliveryPlan.optional(),
  previous: OpeningRecord.optional(),
  transitions: z.array(OpeningStatus).default([]),
  marketing: PlanMarketingInput.omit({ storeSpec: true, openingDate: true }).optional(),
  reviews: z.array(ReviewObservation).default([]),
  handoff: z.boolean().default(false),
  openedAt: IsoDate.optional(),
});
export const assembleOpening = {
  id: 'opening/assembleRecord',
  input: OpeningRecord,
  output: OpeningRecord,
  reads: [],
  params: [],
  async run(record, _ctx) {
    const needs = await validArtifact(record, 'record.hash');
    return { output: needs.length ? null : record, needs, verifications: [] };
  },
} satisfies StepDef<typeof OpeningRecord, typeof OpeningRecord>;
export const steps = [
  ...trainingSteps,
  expandChecklist,
  reschedule,
  importUpstreamIssues,
  evaluateRelease,
  signRelease,
  transition,
  ...marketingSteps,
  review,
  handoff,
  assembleOpening,
] as const;
export const slots = [...trainingSlots, ...marketingSlots] as const;

export async function run(raw: unknown, ctx: StepCtx) {
  const results: Record<string, StepResult<unknown>> = {};
  const needs: Need[] = [];
  const sources: AssetReference[] = [];
  const finish = (artifact: z.infer<typeof OpeningRecord> | null = null) => ({
    steps: results,
    artifact,
    needs,
  });
  const parsed = OpeningInput.safeParse(raw);
  if (!parsed.success) {
    needs.push(...parseNeeds(parsed.error));
    return finish();
  }
  const input = parsed.data;
  const spec = input.storeSpec;
  needs.push(...(await validArtifact(spec, 'storeSpec.hash')));
  if (!spec.storeId)
    needs.push(inputNeed('storeSpec.storeId', 'A store identity is required to open a store'));
  if (input.bomRef.kind !== 'Bom')
    needs.push(inputNeed('bomRef.kind', 'Opening requires a Bom reference'));
  if (spec.body.menu.approved.length !== 1)
    needs.push(
      inputNeed('storeSpec.body.menu.approved', 'Select exactly one approved menu for opening'),
    );
  for (const upstream of [input.buildPlan, input.deliveryPlan, input.previous])
    if (upstream) {
      needs.push(...(await validArtifact(upstream, `${upstream.kind}.hash`)));
      if (upstream.storeId !== spec.storeId)
        needs.push(
          inputNeed(
            `${upstream.kind}.storeId`,
            'All upstream artifacts must belong to the same store',
          ),
        );
    }
  if (
    input.previous &&
    LIVE_STATUSES.has(input.previous.body.status) &&
    input.previous.body.openingDate !== input.openingDate
  )
    needs.push(
      inputNeed('openingDate', 'The actual opening date cannot be rescheduled after opening'),
    );
  if (needs.some((need) => need.blocking)) return finish();
  const scope = { track: spec.body.concept.track, jurisdiction: spec.body.jurisdiction };
  const timezone = spec.body.timezone;
  async function invoke<I extends z.ZodType, O extends z.ZodType>(
    step: StepDef<I, O>,
    value: unknown,
  ): Promise<z.infer<O> | null> {
    const parsed = step.input.safeParse(value);
    const output = parsed.success
      ? await step.run(parsed.data, ctx)
      : { output: null, needs: parseNeeds(parsed.error), verifications: [] };
    const prior = results[step.id];
    results[step.id] = {
      ...output,
      verifications: [...(prior?.verifications ?? []), ...output.verifications],
      fills: [...(prior?.fills ?? []), ...(output.fills ?? [])],
    };
    needs.push(...output.needs);
    if (output.output && typeof output.output === 'object' && 'sources' in output.output)
      sources.push(...(output.output as { sources: AssetReference[] }).sources);
    return output.output;
  }
  const staffing = await invoke(planStaffing, {
    ...scope,
    staffing: spec.body.staffing,
    seats: input.seats,
  });
  if (!staffing) return finish();
  if (
    !(await invoke(checkSopCoverage, {
      ...scope,
      menuRef: spec.body.menu.approved[0],
      openStations: staffing.openStations,
    }))
  )
    return finish();
  const plan = await invoke(buildCertPlan, {
    ...scope,
    templateRef: input.planTemplateRef ?? input.previous?.body.certMatrix.plan,
    items: input.planItems,
  });
  if (!plan) return finish();
  // Cell 不另存目录认证版本；续跑时利用上一版产物的 sources 校验来源。
  const oldSources = new Map(
    input.previous?.sources
      .filter((ref) => ref.slot === 'cert')
      .map((ref) => [ref.id, ref.versionHash]),
  );
  const changedCerts = new Set(
    input.previous
      ? plan.items
          .filter(
            (item) =>
              item.ref?.slot === 'cert' && oldSources.get(item.ref.id) !== item.ref.versionHash,
          )
          .map((item) => item.key)
      : [],
  );
  const priorCells = (input.cells ?? input.previous?.body.certMatrix.cells ?? []).map((cell) => {
    if (!changedCerts.has(cell.certKey)) return cell;
    const { passedAt: _passedAt, recertDue: _recertDue, examiner: _examiner, ...pending } = cell;
    return { ...pending, state: 'pending' as const };
  });
  const matrix = await invoke(deriveCertMatrix, {
    ...scope,
    timezone,
    staffing: staffing.staffing,
    seats: input.seats,
    openStations: staffing.openStations,
    plan: plan.plan,
    planItems: plan.items,
    cells: priorCells,
  });
  if (!matrix) return finish();
  if (
    !(await invoke(pickMaterials, {
      ...scope,
      certKeys: plan.items.filter((item) => item.enabled).map((item) => item.key),
      langs: input.languages,
    }))
  )
    return finish();
  let history = input.examHistory;
  for (const assessment of input.assessments) {
    const index = matrix.cells.findIndex(
      (cell) => cell.seatId === assessment.seatId && cell.certKey === assessment.certKey,
    );
    if (index < 0) {
      needs.push(inputNeed('assessments', 'Assessment must address a currently required cell'));
      return finish();
    }
    const planItem = [...plan.items, ...matrix.courseItems].find(
      (item) => item.key === assessment.certKey,
    );
    if (!planItem) {
      needs.push(
        inputNeed('assessments.certKey', 'Assessment does not match a certification or SOP unit'),
      );
      return finish();
    }
    const assessed = await invoke(applyExam, {
      ...scope,
      timezone,
      ...assessment,
      planItem,
      priorCell: matrix.cells[index],
      history,
    });
    if (!assessed) return finish();
    matrix.cells[index] = assessed.cell;
    history = assessed.history;
  }
  const summary = await invoke(readiness, {
    staffing: staffing.staffing,
    seats: input.seats,
    cells: matrix.cells,
    timezone,
  });
  if (!summary) return finish();
  matrix.summary = summary.summary;
  const checklist = await invoke(expandChecklist, {
    ...scope,
    timezone,
    openingDate: input.openingDate,
    templateRef: input.checklistTemplateRef,
    previous: input.previous?.body.checklist,
    updates: input.checklistUpdates,
    buildPlan: input.buildPlan,
    deliveryPlan: input.deliveryPlan,
  });
  if (!checklist) return finish();
  const issues = await invoke(importUpstreamIssues, {
    issues: input.previous?.body.issues ?? input.issues,
    updates: [...(input.previous ? input.issues : []), ...input.issueUpdates],
    buildPlan: input.buildPlan,
    deliveryPlan: input.deliveryPlan,
    stockRequiredOn: input.openingDate,
    timezone,
  });
  if (!issues) return finish();
  const releaseInput = {
    storeId: spec.storeId!,
    checklist: checklist.checklist,
    matrix: Matrix.parse(matrix),
    issues,
    timezone,
    previous: input.previous,
  };
  if (!(await invoke(evaluateRelease, releaseInput))) return finish();
  // 营销的未审批事项不阻止展示开业阻断，数据缺失则照实返回。
  const marketing = await invoke(planMarketing, {
    ...(input.previous
      ? {
          ledger: input.previous.body.marketing.ledger,
          itemStatuses: input.previous.body.marketing.items.map(({ key, status }) => ({
            key,
            status,
          })),
        }
      : {}),
    ...input.marketing,
    storeSpec: spec,
    openingDate: input.openingDate,
    ...(input.previous && !input.marketing?.previousLedger
      ? { previousLedger: input.previous.body.marketing.ledger }
      : {}),
  });
  const signed = await invoke(signRelease, releaseInput);
  if (!signed || !marketing) return finish();
  const status = input.previous?.body.status ?? 'planning';
  const body = OpeningRecordBody.parse({
    menuRef: spec.body.menu.approved[0],
    bomRef: input.bomRef,
    decidedAt: signed.decidedAt,
    ...scope,
    timezone,
    openingDate: input.openingDate,
    softOpeningDate: input.softOpeningDate,
    status,
    staffing: staffing.staffing,
    certMatrix: Matrix.parse(matrix),
    checklist: checklist.checklist,
    issues,
    release: signed.release,
    marketing: marketing.marketing,
    reviews: input.previous?.body.reviews ?? [],
    handoff: input.previous?.body.handoff ?? null,
  });
  const refs = uniqueRefs([
    ...sources,
    ...spec.sources,
    ...(input.buildPlan?.sources ?? []),
    ...(input.deliveryPlan?.sources ?? []),
    ...(input.previous?.sources ?? []),
  ]);
  async function envelope() {
    const hash = await versionHash(body);
    return OpeningRecord.parse({
      kind: 'OpeningRecord',
      artifactVersion: '0.1.0',
      id: `opening-${hash.slice(0, 32)}`,
      hash,
      producedBy: { step: 'opening/assembleRecord', pkg: '@osw/opening', pkgVersion: '0.1.0' },
      storeId: spec.storeId,
      inputs: [
        artifactRef(spec),
        input.bomRef,
        ...[input.buildPlan, input.deliveryPlan, input.previous].flatMap((artifact) =>
          artifact ? [artifactRef(artifact)] : [],
        ),
      ],
      sources: refs,
      createdAt: ctx.now,
      body,
    });
  }
  for (const target of input.transitions) {
    const next = await invoke(transition, {
      ...releaseInput,
      from: body.status,
      to: target,
      previous: LIVE_STATUSES.has(body.status) ? await envelope() : input.previous,
    });
    if (!next) return finish();
    body.status = next.status;
    body.release = next.release;
    body.decidedAt = next.decidedAt;
  }
  const reviewed = await invoke(review, {
    record: await envelope(),
    storeSpec: spec,
    templateItems: checklist.templateItems,
    complaintAreas: checklist.complaintAreas,
    observations: input.reviews,
  });
  if (!reviewed) return finish();
  body.reviews = reviewed.reviews;
  refs.push(...reviewed.sources);
  if (input.handoff) {
    const handed = await invoke(handoff, { record: await envelope(), openedAt: input.openedAt });
    if (!handed) return finish();
    body.handoff = handed.handoff;
    refs.push(handed.storeRef);
  }
  let artifact = await envelope();
  // example 只由实际来源证明；调用者不能用开关把私有数据标成合成数据。
  const definitions: SlotDef[] = [...SHARED_SLOTS, ...slots];
  const records: (AssetRecordOf<unknown> | null)[] = [];
  for (const ref of refs) {
    const slot = definitions.find((slot) => slot.name === ref.slot);
    records.push(slot ? await ctx.assets.get(slot, ref.id) : null);
  }
  if (
    spec.example &&
    [input.buildPlan, input.deliveryPlan, input.previous].every((item) => !item || item.example) &&
    refs.every(
      (ref, index) =>
        (records[index]?.example &&
          (ref.fieldset
            ? records[index]?.fieldsetHashes?.[ref.fieldset]
            : records[index]?.versionHash) === ref.versionHash) ||
        [spec, input.buildPlan, input.deliveryPlan, input.previous].some(
          (upstream) =>
            upstream?.example &&
            upstream.sources.some((source) => JSON.stringify(source) === JSON.stringify(ref)),
        ),
    )
  )
    artifact = { ...artifact, example: true };
  await invoke(assembleOpening, artifact);
  return finish(artifact);
}
export const workflow: WorkflowModule = { key: 'opening', version: '0.1.0', steps, slots, run };
