import { describe, expect, it } from 'vitest';
import { addWorkdays, criticalPath, schedule, topologicalOrder } from '../src/index.js';
import { fixture, refreshSource, stages } from './fixtures.js';

const task = (
  id: string,
  dependsOn: string[],
  durationDays: number,
  earliestStart = '2026-01-05',
) => ({
  id,
  name: id,
  phase: id,
  lineIds: [],
  dependsOn,
  workHours: durationDays * 10,
  durationDays,
  earliestStart,
});

describe('working-calendar critical path', () => {
  it('forward and backward passes compute a diamond independently', () => {
    const tasks = criticalPath(
      [task('a', [], 1), task('b', ['a'], 2), task('c', ['a'], 4), task('d', ['b', 'c'], 1)],
      [1, 2, 3, 4, 5],
    );
    expect(tasks.map((t) => [t.id, t.start, t.end, t.slackDays, t.critical])).toEqual([
      ['a', '2026-01-05', '2026-01-05', 0, true],
      ['b', '2026-01-06', '2026-01-07', 2, false],
      ['c', '2026-01-06', '2026-01-09', 0, true],
      ['d', '2026-01-12', '2026-01-12', 0, true],
    ]);
    expect(addWorkdays('2026-01-09', 1, [1, 2, 3, 4, 5])).toBe('2026-01-12');
    expect(addWorkdays('2026-01-12', -1, [1, 2, 3, 4, 5])).toBe('2026-01-09');
    expect(() => addWorkdays('2026-01-12', 1, [])).toThrow();
  });
  it('detects cycles, unknown dependencies, and duplicate keys', () => {
    expect(() => topologicalOrder([task('a', ['b'], 1), task('b', ['a'], 1)])).toThrow('cycle');
    expect(() => topologicalOrder([task('a', ['missing'], 1)])).toThrow('Unknown');
    expect(() => topologicalOrder([task('a', [], 1), task('a', [], 1)])).toThrow('Duplicate');
  });
  it('does not delay unrelated tasks for a late arrival, and shifts all work for later possession', async () => {
    const f = await fixture();
    const state = stages(f).bids;
    state.input.delivery.body.arrivals[1].arrivedAt = '2026-01-16';
    let r = await schedule.run(state, f.ctx);
    expect(r.output?.schedule.tasks.find((t) => t.trade === 'carpentry')?.start).toBe('2026-01-05');
    expect(r.output?.schedule.tasks.find((t) => t.trade === 'electrical')?.start).toBe(
      '2026-01-16',
    );
    expect(r.output?.schedule.finish).toBe('2026-01-19');
    state.input.site.body.lease!.possessionDate = '2026-01-20';
    r = await schedule.run(state, f.ctx);
    expect(r.output?.schedule.tasks.every((t) => t.start >= '2026-01-20')).toBe(true);
  });
  it('blocks missing possession, undated deliveries, short deliveries, and damaged stock', async () => {
    const f = await fixture();
    const state = stages(f).bids;
    state.input.site.body.lease!.possessionDate = null;
    expect((await schedule.run(state, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'SiteDecision.lease.possessionDate' }),
    );
    state.input.site.body.lease!.possessionDate = '2026-01-05';
    const arrival = state.input.delivery.body.arrivals[1];
    arrival.arrivedAt = null;
    arrival.eta = null;
    expect((await schedule.run(state, f.ctx)).output).toBeNull();
    arrival.eta = '2026-01-07';
    arrival.receivedQty = 1;
    expect(
      (await schedule.run(state, f.ctx)).needs.some(
        (n) => n.kind === 'input' && n.reason.includes('short'),
      ),
    ).toBe(true);
    arrival.receivedQty = 2;
    arrival.damagedQty = 1;
    expect(
      (await schedule.run(state, f.ctx)).needs.some(
        (n) => n.kind === 'input' && n.reason.includes('damaged'),
      ),
    ).toBe(true);
  });
  it('accumulates split deliveries and only uses enough usable stock', async () => {
    const f = await fixture();
    const state = stages(f).bids;
    const arrival = state.input.delivery.body.arrivals[0];
    arrival.qty = 5;
    arrival.receivedQty = 5;
    state.input.delivery.body.arrivals.push({
      ...arrival,
      shipmentId: 'example-extra',
      qty: 5,
      receivedQty: 5,
      arrivedAt: '2026-01-09',
    });
    const r = await schedule.run(state, f.ctx);
    expect(r.output?.schedule.tasks.find((t) => t.trade === 'carpentry')?.start).toBe('2026-01-09');
  });
  it('requires explicit local availability and rejects ambiguous phase assignment', async () => {
    const f = await fixture();
    const state = stages(f).bids;
    state.input.delivery.body.arrivals = state.input.delivery.body.arrivals.filter(
      (a) => a.bomLineId !== 'example-counter',
    );
    expect((await schedule.run(state, f.ctx)).output).toBeNull();
    state.input.localAvailability['example-counter'] = '2026-01-05';
    expect((await schedule.run(state, f.ctx)).output).not.toBeNull();
    const template = f.records.find((r) => r.id === 'example-build-phases');
    template.data.content.phases.push({
      key: 'duplicate-trade',
      title: 'Duplicate',
      trades: ['carpentry'],
      dependsOn: [],
    });
    refreshSource(f);
    expect((await schedule.run(state, f.ctx)).needs).toContainEqual(
      expect.objectContaining({ path: 'phaseTemplate.lines.example-counter' }),
    );
  });
});
