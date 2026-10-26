import {
  type Need,
  PartySlot,
  type StepDef,
  type Verification,
  diffDays,
  stepResult,
  versionHash,
  z,
} from '@osw/core';
import {
  PARAMS,
  approval,
  approvalNeed,
  assertUnique,
  inputNeed,
  numericParam,
  parameterRefs,
  parametersAreExamples,
  uniqueRefs,
  verification,
  withinPct,
} from '../helpers.js';
import { type BuildOutInput, Scheduled, Tracked } from '../models.js';
import { projectClientQuote } from '../rules/client-view.js';
import { money, repriceQuantities } from '../rules/price.js';
import { buildSchedule } from './schedule.js';

export function changeSubject(quoteHash: string, change: BuildOutInput['changes'][number]) {
  return { quoteHash, change };
}
export const track: StepDef<typeof Scheduled, typeof Tracked> = {
  id: 'build-out/track',
  input: Scheduled,
  output: Tracked,
  reads: ['party', 'template', 'params'],
  params: PARAMS.filter((p) =>
    [
      'verify.installHours.tolerancePct',
      'build.crewSize',
      'build.hoursPerDay',
      'build.workdays',
    ].includes(p.key),
  ),
  approval: {
    question: 'Owner and contractor approve this change?',
    decision: z.enum(['approve']),
  },
  async run(raw, ctx) {
    const state = Scheduled.parse(raw);
    const { input } = state;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const sources = [...state.sources];
    let quote = state.quote;
    let schedule = state.schedule;
    let example = state.example;
    const changes: Tracked['changes'] = [];
    assertUnique(
      input.changes.map((c) => c.id),
      'change order id',
    );
    assertUnique(
      input.actuals.map((a) => a.taskId),
      'task actual',
    );
    assertUnique(
      input.checkpoints.map((c) => c.key),
      'checkpoint',
    );
    let contractorValid = false;
    if (input.contractor) {
      const record = await ctx.assets.get(PartySlot, input.contractor.id);
      contractorValid =
        input.contractor.slot === 'party' &&
        record?.versionHash === input.contractor.versionHash &&
        record.data.roles.some((r) => ['contractor', 'installer'].includes(r));
      if (!contractorValid)
        needs.push(
          inputNeed('contractor', 'Contractor reference must resolve to its stated party revision'),
        );
      else {
        sources.push(input.contractor);
        example &&= record?.example === true;
      }
    }
    for (const change of input.changes) {
      assertUnique(
        change.lineDeltas.map((d) => d.lineId),
        'change line delta',
      );
      if (
        !change.reason.trim() ||
        change.lineDeltas.some((d) => !quote.lines.some((l) => l.id === d.lineId))
      ) {
        needs.push(
          inputNeed(`changes.${change.id}`, 'Change requires a reason and known line ids'),
        );
        continue;
      }
      const hash = await versionHash(changeSubject(quote.quoteHash, change));
      const subject = `change:${change.id}`;
      const owner = approval(ctx, track.id, hash, 'owner', subject);
      const contractor = approval(ctx, track.id, hash, 'contractor', subject);
      const partyMatches =
        contractor?.party &&
        input.contractor &&
        (await versionHash(contractor.party)) === (await versionHash(input.contractor));
      const signed =
        owner?.decision === 'approve' &&
        contractor?.decision === 'approve' &&
        owner.by !== contractor.by &&
        partyMatches &&
        contractorValid;
      if (!signed) {
        changes.push({ ...change, status: 'proposed' });
        needs.push(
          approvalNeed(
            track.id,
            hash,
            'Both owner and the referenced contractor must approve this change',
            subject,
            input.previousPlan?.body.changes.some(
              (c) => c.id === change.id && c.status === 'effective',
            ) ?? false,
          ),
        );
        continue;
      }
      const quantities = new Map(quote.lines.map((l) => [l.id, l.qty]));
      for (const delta of change.lineDeltas)
        quantities.set(delta.lineId, (quantities.get(delta.lineId) as number) + delta.qtyDelta);
      if ([...quantities.values()].some((qty) => qty < 0)) {
        needs.push(
          inputNeed(`changes.${change.id}.lineDeltas`, 'Changed quantities cannot be negative'),
        );
        continue;
      }
      const nextQuote = repriceQuantities(quote, quantities, needs);
      const priceDelta = money(
        nextQuote.totals.total.amount - quote.totals.total.amount,
        quote.currency,
      );
      if (
        priceDelta.currency !== change.priceDelta.currency ||
        priceDelta.amount !== change.priceDelta.amount
      ) {
        needs.push(
          inputNeed(
            `changes.${change.id}.priceDelta`,
            `Signed price delta must equal recalculated delta ${priceDelta.amount} ${priceDelta.currency}`,
          ),
        );
        continue;
      }
      const replanned = await buildSchedule(input, nextQuote, ctx);
      needs.push(...replanned.needs);
      if (!replanned.schedule) continue;
      const days = diffDays(replanned.schedule.finish, schedule.finish);
      if (days !== change.scheduleDeltaDays) {
        needs.push(
          inputNeed(
            `changes.${change.id}.scheduleDeltaDays`,
            `Signed schedule delta must equal recalculated calendar-day delta ${days}`,
          ),
        );
        continue;
      }
      nextQuote.quoteHash = await versionHash(projectClientQuote(nextQuote, input));
      quote = nextQuote;
      schedule = replanned.schedule;
      sources.push(...replanned.sources);
      changes.push({ ...change, status: 'effective' });
    }
    const tolerance = input.actuals.some((a) => a.end)
      ? numericParam(ctx, 'verify.installHours.tolerancePct', input, needs)
      : null;
    if (tolerance !== null)
      example &&= await parametersAreExamples(ctx, ['verify.installHours.tolerancePct'], input);
    if (tolerance !== null)
      sources.push(...parameterRefs(ctx, ['verify.installHours.tolerancePct'], input));
    for (const actual of input.actuals) {
      const task = schedule.tasks.find((t) => t.id === actual.taskId);
      if (!task) {
        needs.push(inputNeed(`actuals.${actual.taskId}`, 'Unknown task'));
        continue;
      }
      if (
        (actual.end && actual.end < actual.start) ||
        actual.start < task.start ||
        actual.start > ctx.now.slice(0, 10) ||
        (actual.end && actual.end > ctx.now.slice(0, 10))
      ) {
        needs.push(
          inputNeed(
            `actuals.${actual.taskId}`,
            'Actual dates must respect release dates and cannot be in the future',
          ),
        );
        continue;
      }
      for (const id of task.dependsOn) {
        const predecessor = schedule.tasks.find((t) => t.id === id);
        const finished = input.actuals.find((a) => a.taskId === id)?.end;
        if (!finished || finished >= actual.start)
          needs.push(
            inputNeed(
              `actuals.${actual.taskId}`,
              `Predecessor ${id} must finish before this work starts`,
            ),
          );
        if (
          predecessor?.checkpoint &&
          !input.checkpoints.some(
            (c) => c.key === predecessor.checkpoint && c.passedAt <= actual.start,
          )
        )
          needs.push(
            inputNeed(
              `checkpoints.${predecessor.checkpoint}`,
              'Predecessor checkpoint needs dated evidence before work starts',
            ),
          );
      }
      const { taskId: _taskId, ...value } = actual;
      task.actual = value;
      const lines = quote.lines.filter((l) => task.lineIds.includes(l.id));
      const qty = lines.reduce((s, l) => s + l.qty, 0);
      if (actual.end && qty > 0 && tolerance !== null) {
        const expected = task.workHours / qty;
        const observed = actual.hours / qty;
        // 混有人工覆盖值时无法把任务总工时归因给资产基准，避免写出误导性验证。
        if (lines.every((l) => !l.install.overridden))
          for (const ref of uniqueRefs(
            lines.flatMap((l) => (l.install.rateRef ? [l.install.rateRef] : [])),
          ))
            verifications.push(
              verification(
                ctx,
                ref,
                track.id,
                'hoursPerUnit',
                expected,
                observed,
                withinPct(observed, expected, tolerance),
                'h',
              ),
            );
      }
    }
    return stepResult(
      Tracked.parse({ ...state, quote, schedule, changes, sources: uniqueRefs(sources), example }),
      needs,
      verifications,
    );
  },
};
