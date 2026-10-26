import { AssetRef, type Need, type StepDef, assetRef, z } from '@osw/core';
import { RoleSlot } from '../slots/role.js';
import {
  inputNeed,
  parseInput,
  trainingQuery,
  trainingResult,
  trainingVerification,
} from './helpers.js';
import { Seat, Staffing, StaffingPlan, TrainingScope } from './models.js';
export const PlanStaffingInput = TrainingScope.extend({
  staffing: StaffingPlan,
  seats: z.array(Seat),
});
export const PlanStaffingOutput = z.object({
  staffing: Staffing,
  openStations: z.array(z.string()),
  sources: z.array(AssetRef),
});
export const planStaffing: StepDef<typeof PlanStaffingInput, typeof PlanStaffingOutput> = {
  id: 'opening/planStaffing',
  input: PlanStaffingInput,
  output: PlanStaffingOutput,
  reads: ['role'],
  params: [],
  async run(raw, ctx) {
    const parsed = parseInput(PlanStaffingInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    if (new Set(input.staffing.map((s) => s.positionKey)).size !== input.staffing.length)
      needs.push(inputNeed('staffing', 'Position keys must be unique'));
    if (new Set(input.seats.map((s) => s.seatId)).size !== input.seats.length)
      needs.push(inputNeed('seats', 'Seat ids must be unique'));
    const keys = [
      ...new Set([
        ...input.staffing.map((s) => s.positionKey),
        ...input.seats.map((s) => s.positionKey),
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
    const roleByKey = new Map(roles.map((r) => [r.data.key, r]));
    if (roleByKey.size !== roles.length) needs.push(inputNeed('role', 'Role keys are ambiguous'));
    for (const key of keys)
      if (!roleByKey.has(key))
        needs.push({
          kind: 'asset',
          slot: 'role',
          filter: { field: 'key', op: 'eq', value: key },
          reason: 'Staffing position has no role asset',
          blocking: true,
        });
    const active = new Map<string, number>();
    for (const seat of input.seats)
      if (seat.status === 'active')
        active.set(seat.positionKey, (active.get(seat.positionKey) ?? 0) + 1);
    const staffing = input.staffing.map((s) => ({
      positionKey: s.positionKey,
      planned: s.headcount,
      staffed: active.get(s.positionKey) ?? 0,
    }));
    for (const [positionKey, staffed] of active)
      if (!staffing.some((s) => s.positionKey === positionKey))
        staffing.push({ positionKey, planned: 0, staffed });
    const openStations = [
      ...new Set(
        staffing
          .filter((s) => s.planned > 0 || s.staffed > 0)
          .flatMap((s) => roleByKey.get(s.positionKey)?.data.stationKey ?? []),
      ),
    ].sort();
    return trainingResult(
      { staffing, openStations, sources: roles.map((r) => assetRef(r)) },
      needs,
    );
  },
};
