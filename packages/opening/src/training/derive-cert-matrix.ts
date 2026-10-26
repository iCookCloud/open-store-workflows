import { AssetRef, type Need, type StepDef, assetRef, todayIn, z } from '@osw/core';
import { CourseSlot } from '../slots/course.js';
import { RoleSlot } from '../slots/role.js';
import {
  inputNeed,
  jurisdictionFit,
  parseInput,
  trackFilter,
  trainingQuery,
  trainingResult,
  uniqueTrainingRefs,
} from './helpers.js';
import { Cell, PlanItem, ReadinessSummary, Seat, Staffing, TrainingScope } from './models.js';
import { calculateReadiness } from './readiness.js';
export const DeriveCertMatrixInput = TrainingScope.extend({
  timezone: z.string().min(1),
  staffing: Staffing,
  seats: z.array(Seat),
  openStations: z.array(z.string()),
  plan: AssetRef,
  planItems: z.array(PlanItem),
  cells: z.array(Cell).default([]),
});
export const DeriveCertMatrixOutput = z.object({
  plan: AssetRef,
  seats: z.array(Seat),
  cells: z.array(Cell),
  summary: ReadinessSummary,
  pct: z.number().nullable(),
  sources: z.array(AssetRef),
  courseItems: z.array(PlanItem),
});
export const courseCertKey = (courseId: string, unitId: string) => `course:${courseId}:${unitId}`;
export const deriveCertMatrix: StepDef<
  typeof DeriveCertMatrixInput,
  typeof DeriveCertMatrixOutput
> = {
  id: 'opening/deriveCertMatrix',
  input: DeriveCertMatrixInput,
  output: DeriveCertMatrixOutput,
  reads: ['course', 'role'],
  params: [],
  async run(raw, ctx) {
    const parsed = parseInput(DeriveCertMatrixInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    let today: string;
    try {
      today = todayIn(input.timezone, ctx.now);
    } catch {
      return trainingResult(null, [inputNeed('timezone', 'A valid IANA timezone is required')]);
    }
    if (input.plan.slot !== 'template')
      needs.push(inputNeed('plan.slot', 'Certification plan must reference a template'));
    if (new Set(input.seats.map((s) => s.seatId)).size !== input.seats.length)
      needs.push(inputNeed('seats', 'Seat ids must be unique'));
    if (
      new Set(input.cells.map((c) => JSON.stringify([c.seatId, c.certKey]))).size !==
      input.cells.length
    )
      needs.push(inputNeed('cells', 'Seat-certification pairs must be unique'));
    if (new Set(input.planItems.map((c) => c.key)).size !== input.planItems.length)
      needs.push(inputNeed('planItems', 'Certification keys must be unique'));
    const keys = [
      ...new Set([
        ...input.seats.map((s) => s.positionKey),
        ...input.planItems.flatMap((c) => c.positions),
      ]),
    ];
    const roles = [];
    for (let offset = 0; offset < keys.length; offset += 200)
      roles.push(
        ...(await trainingQuery(ctx.assets, RoleSlot, {
          field: 'key',
          op: 'in',
          value: keys.slice(offset, offset + 200),
        })),
      );
    const roleMap = new Map(roles.map((r) => [r.data.key, r.data]));
    const courses = (await trainingQuery(ctx.assets, CourseSlot, trackFilter(input.track))).filter(
      (r) => jurisdictionFit(input.jurisdiction, r.coverage.jurisdictions) !== 'no',
    );
    const previous = new Map(
      input.cells.map((cell) => [JSON.stringify([cell.seatId, cell.certKey]), cell]),
    );
    const enabledKeys = new Set(input.planItems.filter((c) => c.enabled).map((c) => c.key));
    const resolved = input.planItems.filter(
      (c) => c.enabled && !(c.supersededBy ?? []).some((key) => enabledKeys.has(key)),
    );
    const courseItems: z.infer<typeof PlanItem>[] = courses.flatMap((course) =>
      course.data.units.map((unit, index) => ({
        key: courseCertKey(course.id, unit.id),
        standard: input.planItems[0]?.standard ?? 'course',
        title: { und: unit.title },
        group: 'course',
        positions: unit.positions,
        critical: unit.critical,
        locked: false,
        requires: ['practical' as const],
        defaultChecks: unit.controls,
        checks: unit.controls,
        enabled: true,
        ...(unit.station ? { stationKey: unit.station } : {}),
        ref: assetRef(course, undefined, `/units/${index}`),
      })),
    );
    const cells: z.infer<typeof Cell>[] = [];
    const requiredIndex = new Map<string, number>();
    function bindSop(
      cell: z.infer<typeof Cell>,
      sop?: z.infer<typeof AssetRef>,
    ): z.infer<typeof Cell> {
      if (!sop) return cell;
      const old = cell.sop;
      const matches =
        old &&
        old.slot === sop.slot &&
        old.id === sop.id &&
        old.versionHash === sop.versionHash &&
        old.fieldset === sop.fieldset &&
        old.path === sop.path;
      if (matches) return { ...cell, sop };
      // 考核结论绑定所见课程版本；换版后只保留历史考次，不挪用旧版通过与签字。
      const { passedAt: _passedAt, recertDue: _recertDue, examiner: _examiner, ...pending } = cell;
      return { ...pending, state: 'pending', sop };
    }
    function required(
      seatId: string,
      key: string,
      critical: boolean,
      locked: boolean,
      sop?: z.infer<typeof AssetRef>,
    ) {
      const cellKey = JSON.stringify([seatId, key]);
      const existingIndex = requiredIndex.get(cellKey);
      if (existingIndex !== undefined) {
        const existing = cells[existingIndex];
        cells[existingIndex] = bindSop(
          {
            ...existing,
            critical: existing.critical || critical,
            locked: existing.locked || locked,
          },
          sop,
        );
        return;
      }
      requiredIndex.set(cellKey, cells.length);
      const old = previous.get(cellKey);
      const state =
        old?.state === 'passed' && old.recertDue && old.recertDue <= today
          ? 'expired'
          : (old?.state ?? 'pending');
      cells.push(
        bindSop(
          {
            ...old,
            seatId,
            certKey: key,
            critical,
            locked,
            state,
            attempts: old?.attempts ?? 0,
          },
          sop,
        ),
      );
    }
    for (const seat of input.seats) {
      if (seat.status !== 'active') continue;
      const role = roleMap.get(seat.positionKey);
      if (!role) {
        needs.push(inputNeed(`seats.${seat.seatId}.positionKey`, 'Seat role is unavailable'));
        continue;
      }
      for (const item of resolved) {
        if (item.positions.length && !item.positions.includes(seat.positionKey) && !role.relief)
          continue;
        const ownerStations = item.stationKey
          ? [item.stationKey]
          : [...new Set(item.positions.flatMap((key) => roleMap.get(key)?.stationKey ?? []))];
        if (
          role.relief &&
          ownerStations.length &&
          !ownerStations.some((station) => input.openStations.includes(station))
        )
          continue;
        required(seat.seatId, item.key, item.critical, item.locked);
      }
      for (const course of courses)
        for (const [unitIndex, unit] of course.data.units.entries()) {
          if (!unit.positions.includes(seat.positionKey)) continue;
          if (role.relief && unit.station && !input.openStations.includes(unit.station)) continue;
          required(
            seat.seatId,
            courseCertKey(course.id, unit.id),
            unit.critical,
            false,
            assetRef(course, undefined, `/units/${unitIndex}`),
          );
        }
    }
    const summary = calculateReadiness(
      { staffing: input.staffing, seats: input.seats, cells, timezone: input.timezone },
      today,
    );
    return trainingResult(
      {
        plan: input.plan,
        seats: input.seats,
        cells,
        ...summary,
        courseItems,
        sources: uniqueTrainingRefs([
          input.plan,
          ...input.planItems.flatMap((i) => i.ref ?? []),
          ...roles.map((r) => assetRef(r)),
          ...courses.map((r) => assetRef(r)),
        ]),
      },
      needs,
    );
  },
};
