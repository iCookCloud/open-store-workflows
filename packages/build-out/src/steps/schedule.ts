import { type Need, type StepCtx, type StepDef, stepResult } from '@osw/core';
import {
  PARAMS,
  inputNeed,
  loadTemplate,
  numericParam,
  parameterRefs,
  parametersAreExamples,
  scopeFor,
  uniqueRefs,
} from '../helpers.js';
import { Bids, type BuildOutInput, Scheduled } from '../models.js';
import { type TaskInput, criticalPath, parseWorkdays, topologicalOrder } from '../rules/cpm.js';
import type { Quote } from '../rules/price.js';
import { PhaseTemplate } from '../slots.js';

export function lineAvailability(input: BuildOutInput, line: Quote['lines'][number]) {
  const arrivals = input.delivery.body.arrivals.filter(
    (a) => a.bomLineId === (line.bomLineId ?? line.id),
  );
  if (!arrivals.length)
    return { date: input.localAvailability[line.id] ?? null, reason: 'no-eta' as const };
  let quantity = 0;
  let date: string | null = null;
  const dated = arrivals
    .filter((a) => a.arrivedAt ?? a.eta)
    .sort((a, b) =>
      (a.arrivedAt ?? (a.eta as string)) < (b.arrivedAt ?? (b.eta as string)) ? -1 : 1,
    );
  for (const arrival of dated) {
    quantity += Math.max(0, (arrival.receivedQty ?? arrival.qty) - (arrival.damagedQty ?? 0));
    date = arrival.arrivedAt ?? arrival.eta;
    if (quantity >= line.qty) return { date, reason: 'no-eta' as const };
  }
  return {
    date: null,
    reason: arrivals.some((a) => (a.damagedQty ?? 0) > 0)
      ? ('damaged' as const)
      : arrivals.some((a) => !a.arrivedAt && !a.eta)
        ? ('no-eta' as const)
        : ('short' as const),
  };
}
export async function buildSchedule(input: BuildOutInput, quote: Quote, ctx: StepCtx) {
  const needs: Need[] = [];
  const crew = numericParam(ctx, 'build.crewSize', input, needs, true, true);
  const hours = numericParam(ctx, 'build.hoursPerDay', input, needs, true);
  const calendar = ctx.params.get('build.workdays', scopeFor(input));
  let weekdays: number[] = [];
  if (!calendar)
    needs.push(
      ctx.params.need?.('build.workdays', scopeFor(input)) ?? {
        kind: 'param',
        key: 'build.workdays',
        reason: 'missing',
        blocking: true,
      },
    );
  else {
    try {
      weekdays = parseWorkdays(String(calendar.value));
    } catch {
      needs.push(inputNeed('params.build.workdays', 'Expected comma-separated ISO weekdays'));
    }
  }
  const template = await loadTemplate(
    ctx,
    input,
    input.phaseTemplateId,
    'buildout-phases',
    PhaseTemplate,
    needs,
  );
  const possession = input.site.body.lease?.possessionDate;
  if (!possession)
    needs.push(
      inputNeed(
        'SiteDecision.lease.possessionDate',
        'A possession date is required for all site work',
      ),
    );
  const blocked: Scheduled['schedule']['blocked'] = [];
  const dates = new Map<string, string>();
  for (const line of quote.lines.filter((l) => l.qty > 0)) {
    if (input.delivery.body.held.some((held) => held.bomLineId === (line.bomLineId ?? line.id)))
      needs.push(
        inputNeed(
          `DeliveryPlan.held.${line.bomLineId ?? line.id}`,
          'This line is still held by the delivery workflow',
        ),
      );
    const arrival = lineAvailability(input, line);
    if (!arrival.date) {
      blocked.push({ lineId: line.id, reason: arrival.reason });
      needs.push(
        inputNeed(
          `DeliveryPlan.arrivals[bomLineId=${line.bomLineId ?? line.id}].eta`,
          `Line is unavailable: ${arrival.reason}; supply dated usable stock or explicit local availability`,
        ),
      );
    } else dates.set(line.id, arrival.date);
  }
  if (!template || !crew || !hours || !possession || !weekdays.length)
    return { schedule: null, needs, sources: [], example: false };
  topologicalOrder(template.content.phases.map((p) => ({ ...p, id: p.key })));
  const assignments = new Map<string, string>();
  for (const line of quote.lines) {
    const phases = template.content.phases.filter((p) =>
      line.trade ? p.trades?.includes(line.trade) : !p.trades?.length && !p.checkpoint,
    );
    if (phases.length !== 1)
      needs.push(
        inputNeed(
          `phaseTemplate.lines.${line.id}`,
          'Every line must map to exactly one phase; split the line when work spans phases',
        ),
      );
    else assignments.set(line.id, phases[0].key);
  }
  const tasks: TaskInput[] = [];
  const phaseTasks = new Map<string, string[]>();
  for (const phase of template.content.phases) {
    const assigned = quote.lines.filter((l) => assignments.get(l.id) === phase.key);
    const trades = [...new Set(assigned.map((l) => l.trade ?? ''))];
    if (!trades.length) trades.push('');
    for (const trade of trades) {
      const lines = assigned.filter((l) => (l.trade ?? '') === trade);
      const workHours = lines.reduce((s, l) => s + l.qty * l.install.hoursPerUnit, 0);
      const id = trade ? `${phase.key}:${trade}` : phase.key;
      tasks.push({
        id,
        name: phase.title,
        phase: phase.key,
        ...(trade ? { trade } : {}),
        lineIds: lines.map((l) => l.id),
        dependsOn: [],
        ...(phase.checkpoint ? { checkpoint: phase.checkpoint } : {}),
        workHours,
        durationDays: Math.ceil(workHours / (crew * hours)),
        earliestStart: [
          input.startNotBefore ?? ctx.now.slice(0, 10),
          possession,
          ...lines.flatMap((l) => (dates.get(l.id) ? [dates.get(l.id) as string] : [])),
        ]
          .sort()
          .at(-1) as string,
      });
      phaseTasks.set(phase.key, [...(phaseTasks.get(phase.key) ?? []), id]);
    }
  }
  for (const task of tasks)
    task.dependsOn =
      template.content.phases
        .find((p) => p.key === task.phase)
        ?.dependsOn.flatMap((key) => phaseTasks.get(key) ?? []) ?? [];
  const sources = [
    template.ref,
    ...parameterRefs(ctx, ['build.crewSize', 'build.hoursPerDay', 'build.workdays'], input),
  ];
  if (needs.some((n) => n.blocking))
    return {
      schedule: null,
      needs,
      sources,
      example:
        template.record.example === true &&
        (await parametersAreExamples(
          ctx,
          ['build.crewSize', 'build.hoursPerDay', 'build.workdays'],
          input,
        )),
    };
  const scheduled = criticalPath(tasks, weekdays);
  const schedule = {
    tasks: scheduled,
    start: scheduled.map((t) => t.start).sort()[0],
    finish: scheduled
      .map((t) => t.end)
      .sort()
      .at(-1) as string,
    criticalPath: scheduled.filter((t) => t.critical).map((t) => t.id),
    blocked,
  };
  return {
    schedule,
    needs,
    sources,
    example:
      template.record.example === true &&
      (await parametersAreExamples(
        ctx,
        ['build.crewSize', 'build.hoursPerDay', 'build.workdays'],
        input,
      )),
  };
}
export const schedule: StepDef<typeof Bids, typeof Scheduled> = {
  id: 'build-out/schedule',
  input: Bids,
  output: Scheduled,
  reads: ['template', 'params'],
  params: PARAMS.filter((p) =>
    ['build.crewSize', 'build.hoursPerDay', 'build.workdays'].includes(p.key),
  ),
  async run(raw, ctx) {
    const state = Bids.parse(raw);
    const result = await buildSchedule(state.input, state.quote, ctx);
    if (!result.schedule) return { output: null, needs: result.needs, verifications: [] };
    return stepResult(
      Scheduled.parse({
        ...state,
        schedule: result.schedule,
        sources: uniqueRefs([...state.sources, ...result.sources]),
        example: state.example && result.example,
      }),
      result.needs,
    );
  },
};
