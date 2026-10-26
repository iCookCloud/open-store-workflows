import { type BuildTask, IsoDate, addDays, type z } from '@osw/core';

export function parseWorkdays(value: string): number[] {
  if (!/^[1-7](,[1-7])*$/.test(value))
    throw new Error('Workdays must be comma-separated ISO weekdays');
  return [...new Set(value.split(',').map(Number))];
}
export function isWorkday(date: string, weekdays: readonly number[]) {
  return weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay() || 7);
}
export function workdayOnOrAfter(date: string, weekdays: readonly number[]) {
  IsoDate.parse(date);
  if (!weekdays.length || weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new Error('Invalid work calendar');
  let result = date;
  while (!isWorkday(result, weekdays)) result = addDays(result, 1);
  return result;
}
export function addWorkdays(date: string, days: number, weekdays: readonly number[]): string {
  if (!Number.isInteger(days)) throw new Error('Workday offset must be an integer');
  workdayOnOrAfter(date, weekdays);
  let result = date;
  const direction = days < 0 ? -1 : 1;
  for (let left = Math.abs(days); left > 0; ) {
    result = addDays(result, direction);
    if (isWorkday(result, weekdays)) left--;
  }
  return result;
}
export function topologicalOrder<T extends { id: string; dependsOn: string[] }>(
  nodes: readonly T[],
): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error('Duplicate task or checklist key');
  const visiting = new Set<string>();
  const done = new Set<string>();
  const result: T[] = [];
  function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('Dependency cycle in template');
    const node = byId.get(id);
    if (!node) throw new Error(`Unknown dependency ${id}`);
    visiting.add(id);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
    result.push(node);
  }
  for (const node of nodes) visit(node.id);
  return result;
}
type Task = z.infer<typeof BuildTask>;
export type TaskInput = Omit<Task, 'start' | 'end' | 'slackDays' | 'critical'>;
export function criticalPath(tasks: TaskInput[], weekdays: readonly number[]): Task[] {
  const ordered = topologicalOrder(tasks);
  const scheduled = new Map<string, Task>();
  for (const task of ordered) {
    const earliest = [
      task.earliestStart,
      ...task.dependsOn.map((id) => addDays((scheduled.get(id) as Task).end, 1)),
    ]
      .sort()
      .at(-1) as string;
    const start = workdayOnOrAfter(earliest, weekdays);
    scheduled.set(task.id, {
      ...task,
      earliestStart: start,
      start,
      end: addWorkdays(start, Math.max(0, task.durationDays - 1), weekdays),
      slackDays: 0,
      critical: false,
    });
  }
  const finish = [...scheduled.values()]
    .map((t) => t.end)
    .sort()
    .at(-1);
  if (!finish) return [];
  const latest = new Map<string, string>();
  for (const task of [...ordered].reverse()) {
    const successors = ordered.filter((n) => n.dependsOn.includes(task.id));
    const end = successors.length
      ? successors.map((s) => addWorkdays(latest.get(s.id) as string, -1, weekdays)).sort()[0]
      : finish;
    const start = addWorkdays(end, -Math.max(0, task.durationDays - 1), weekdays);
    latest.set(task.id, start);
    const actual = scheduled.get(task.id) as Task;
    let slack = 0;
    for (let d = actual.start; d < start; d = addWorkdays(d, 1, weekdays)) slack++;
    actual.slackDays = slack;
    actual.critical = slack === 0;
  }
  return ordered.map((t) => scheduled.get(t.id) as Task);
}
