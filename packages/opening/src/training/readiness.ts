import { type StepDef, todayIn, z } from '@osw/core';
import { inputNeed, parseInput, trainingResult } from './helpers.js';
import { Cell, ReadinessSummary, Seat, Staffing } from './models.js';
export const ReadinessInput = z.object({
  staffing: Staffing,
  seats: z.array(Seat),
  cells: z.array(Cell),
  timezone: z.string().min(1),
});
export const ReadinessOutput = z.object({
  summary: ReadinessSummary,
  pct: z.number().min(0).max(100).nullable(),
});
export function calculateReadiness(
  input: z.infer<typeof ReadinessInput>,
  today: string,
): z.infer<typeof ReadinessOutput> {
  const active = input.seats.filter((seat) => seat.status === 'active');
  const activeIds = new Set(active.map((seat) => seat.seatId));
  const counts = new Map<string, number>();
  for (const seat of active) counts.set(seat.positionKey, (counts.get(seat.positionKey) ?? 0) + 1);
  const gaps = input.staffing
    .filter((row) => (counts.get(row.positionKey) ?? 0) < row.planned)
    .map((row) => ({
      position: row.positionKey,
      plan: row.planned,
      actual: counts.get(row.positionKey) ?? 0,
    }));
  const cells = input.cells.filter((cell) => activeIds.has(cell.seatId));
  const passed = (cell: z.infer<typeof Cell>) =>
    cell.state === 'passed' && !(cell.recertDue && cell.recertDue <= today);
  const certRequired = cells.length;
  const certPassed = cells.filter(passed).length;
  const critical = cells.filter((cell) => cell.critical);
  const criticalPassed = critical.filter(passed).length;
  const planTotal = input.staffing.reduce((sum, row) => sum + row.planned, 0);
  return {
    summary: {
      planTotal,
      staffed: active.length,
      gaps,
      certRequired,
      certPassed,
      criticalRequired: critical.length,
      criticalPassed,
      criticalPending: critical.length - criticalPassed,
      expiring: cells.filter((cell) => cell.recertDue && cell.recertDue <= today).length,
      hollow: active.length === 0,
      ready:
        planTotal > 0 &&
        active.length > 0 &&
        gaps.length === 0 &&
        critical.length > 0 &&
        criticalPassed === critical.length,
    },
    pct: certRequired > 0 ? Math.round((certPassed / certRequired) * 100) : null,
  };
}
export const readiness: StepDef<typeof ReadinessInput, typeof ReadinessOutput> = {
  id: 'opening/readiness',
  input: ReadinessInput,
  output: ReadinessOutput,
  reads: [],
  params: [],
  async run(raw, ctx) {
    const parsed = parseInput(ReadinessInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    if (
      new Set(input.seats.map((s) => s.seatId)).size !== input.seats.length ||
      new Set(input.cells.map((c) => JSON.stringify([c.seatId, c.certKey]))).size !==
        input.cells.length
    )
      return trainingResult(null, [
        inputNeed('cells', 'Seat ids and seat-certification cell pairs must be unique'),
      ]);
    let today: string;
    try {
      today = todayIn(input.timezone, ctx.now);
    } catch {
      return trainingResult(null, [inputNeed('timezone', 'A valid IANA timezone is required')]);
    }
    return trainingResult(calculateReadiness(input, today));
  },
};
