import { MemorySource, SHARED_SLOTS, assetRef, versionHash } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { jurisdictionFit } from '../src/helpers.js';
import { expandChecklist, reschedule } from '../src/lifecycle/checklist.js';
import { importUpstreamIssues } from '../src/lifecycle/issues.js';
import { evaluateRelease, handoff, signRelease, transition } from '../src/lifecycle/release.js';
import { checklist, context, matrix, now, record, releaseInput } from './lifecycle-fixtures.js';

async function approval(input = releaseInput, decision = 'go') {
  const evaluated = await evaluateRelease.run(input, context());
  return {
    step: 'opening/signRelease',
    subject: `store:${input.storeId}`,
    subjectHash: await versionHash(evaluated.output!.blockers),
    decision,
    at: now,
    by: 'example:reviewer',
  };
}
async function sourceRecord(slot: string, id: string, data: unknown) {
  return {
    slot,
    id,
    data,
    slotVersion: '0.1.0',
    versionHash: await versionHash(data),
    coverage: { tier: 'general' as const, tracks: [], jurisdictions: [], workflows: [] },
    updatedAt: now,
    example: true as const,
  };
}
describe('opening release and continuity', () => {
  it('requires a store-scoped current approval and rejects future or invalid decisions', async () => {
    const ctx = context();
    expect((await signRelease.run(releaseInput, ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: 'store:example-opening-store' }),
    );
    const a = await approval();
    expect(
      (await signRelease.run(releaseInput, { ...ctx, approvals: [a] })).output?.decidedAt,
    ).toBe(now);
    expect(
      (
        await signRelease.run(releaseInput, {
          ...ctx,
          approvals: [{ ...a, at: '2027-01-01T00:00:00Z' }],
        })
      ).output,
    ).toBeNull();
    expect(
      (await signRelease.run({ ...releaseInput, storeId: 'another' }, { ...ctx, approvals: [a] }))
        .output,
    ).toBeNull();
    expect(
      (await signRelease.run(releaseInput, { ...ctx, approvals: [{ ...a, decision: 'no_go' }] }))
        .output,
    ).toBeNull();
  });
  it('does not waive P0, locked failures, missing staffing or missing critical requirements', async () => {
    const p0 = {
      id: 'p0',
      area: 'build',
      severity: 'P0' as const,
      status: 'open' as const,
      refs: [],
      openedOn: '2026-03-01',
    };
    const cases = [
      { ...releaseInput, matrix: null },
      { ...releaseInput, matrix: { ...matrix, seats: [] } },
      { ...releaseInput, matrix: { ...matrix, cells: [] } },
      {
        ...releaseInput,
        matrix: {
          ...matrix,
          summary: { ...matrix.summary, gaps: [{ position: 'cook', plan: 2, actual: 1 }] },
        },
      },
      {
        ...releaseInput,
        matrix: { ...matrix, cells: [{ ...matrix.cells[0], state: 'failed' as const }] },
      },
      { ...releaseInput, issues: [p0] },
    ];
    for (const input of cases) {
      const evaluated = await evaluateRelease.run(input, context());
      expect(evaluated.output?.state).toBe('blocked');
      const a = {
        step: 'opening/signRelease',
        subject: `store:${input.storeId}`,
        subjectHash: await versionHash(evaluated.output!.blockers),
        decision: 'go_with_conditions',
        at: now,
        by: 'example:reviewer',
        note: 'Attempted waiver',
      };
      expect((await signRelease.run(input, { ...context(), approvals: [a] })).output).toBeNull();
    }
  });
  it('requires complete conditions, expires certificates on their due date, and invalidates changed blockers', async () => {
    const input = {
      ...releaseInput,
      matrix: {
        ...matrix,
        cells: [{ ...matrix.cells[0], locked: false, recertDue: '2026-03-01' }],
      },
    };
    const evaluated = await evaluateRelease.run(input, context());
    expect(evaluated.output?.state).toBe('conditional');
    const a = {
      step: 'opening/signRelease',
      subject: 'store:example-opening-store',
      subjectHash: await versionHash(evaluated.output!.blockers),
      decision: 'go_with_conditions',
      at: now,
      by: 'example:reviewer',
      note: 'Supervision required',
      conditions: [
        { ref: 'seat-a|safety', text: 'Cannot work independently', dueDate: '2026-03-02' },
      ],
    };
    expect(
      (await signRelease.run(input, { ...context(), approvals: [a] })).output?.release.signed
        ?.decision,
    ).toBe('go_with_conditions');
    expect(
      (await signRelease.run(input, { ...context(), approvals: [{ ...a, conditions: [] }] }))
        .output,
    ).toBeNull();
    expect(
      (await signRelease.run(releaseInput, { ...context(), approvals: [a] })).output,
    ).toBeNull();
  });
  it('rejects a new pre-live P0 and freezes an established live signature while keeping current blockers visible', async () => {
    const a = await approval();
    const issues = [
      {
        id: 'new-p0',
        area: 'equipment',
        severity: 'P0' as const,
        status: 'open' as const,
        refs: [],
        openedOn: '2026-03-01',
      },
    ];
    expect(
      (
        await transition.run(
          { ...releaseInput, issues, from: 'ready', to: 'live' },
          { ...context(), approvals: [a] },
        )
      ).output,
    ).toBeNull();
    const previous = await record();
    const continued = await signRelease.run({ ...releaseInput, issues, previous }, context());
    expect(continued.output?.release.current.state).toBe('blocked');
    expect(continued.output?.release.signed).toEqual(previous.body.release.signed);
    expect(
      (
        await signRelease.run(
          { ...releaseInput, previous: { ...previous, hash: 'f'.repeat(64) } },
          context(),
        )
      ).output,
    ).toBeNull();
    expect(
      (
        await transition.run(
          { ...releaseInput, from: 'planning', to: 'live' },
          { ...context(), approvals: [a] },
        )
      ).output,
    ).toBeNull();
  });
  it('requires issue closure evidence and clears the closure date when reopened', async () => {
    const issue = {
      id: 'one',
      area: 'service',
      severity: 'P1' as const,
      status: 'closed' as const,
      openedOn: '2026-02-28',
      closedOn: '2026-03-01',
      refs: [],
    };
    expect(
      (
        await importUpstreamIssues.run(
          { issues: [issue], updates: [], stockRequiredOn: '2026-03-01', timezone: 'UTC' },
          context(),
        )
      ).output,
    ).toBeNull();
    const reopened = await importUpstreamIssues.run(
      {
        issues: [{ ...issue, verificationNote: 'Checked' }],
        updates: [{ ...issue, status: 'open' }],
        stockRequiredOn: '2026-03-01',
        timezone: 'UTC',
      },
      context(),
    );
    expect(reopened.output?.[0]).not.toHaveProperty('closedOn');
  });
  it('requires an operating approval with note and emits only an openedAt fill', async () => {
    const prior = await record();
    const store = await sourceRecord('store', prior.storeId!, {
      name: { en: 'Example Store' },
      status: 'preparing',
      track: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      openedAt: '2026-02-20',
    });
    const assets = new MemorySource([store], SHARED_SLOTS);
    const ctx = { ...context(), assets };
    const pending = await handoff.run({ record: prior }, ctx);
    expect(pending.needs[0].kind).toBe('approval');
    const hash = await versionHash({ storeId: prior.storeId, openedAt: '2026-02-20' });
    const a = {
      step: 'opening/handoff',
      subjectHash: hash,
      decision: 'operating',
      at: now,
      by: 'example:reviewer',
    };
    expect((await handoff.run({ record: prior }, { ...ctx, approvals: [a] })).output).toBeNull();
    const done = await handoff.run(
      { record: prior },
      { ...ctx, approvals: [{ ...a, note: 'Doors opened' }] },
    );
    expect(done.fills).toEqual([
      {
        asset: assetRef(store),
        field: 'openedAt',
        value: '2026-02-20',
        at: now,
        by: 'example:reviewer',
      },
    ]);
    expect(await assets.applyFills(done.fills!)).toEqual([{ status: 'not_empty' }]);
  });
});
describe('opening checklist dates and jurisdiction', () => {
  it('compares jurisdiction segment boundaries and retains unsure and inapplicable items', async () => {
    expect(jurisdictionFit('US-NYX', 'US-NY')).toBe('no');
    expect(jurisdictionFit('US', 'US-NY')).toBe('unsure');
    const tpl = await sourceRecord('template', 'checklist', {
      kind: 'opening-checklist',
      format: 'json',
      title: { en: 'Example Checklist' },
      lang: 'en',
      content: {
        items: [
          {
            key: 'state',
            title: 'Example state item',
            phase: 'before',
            dayOffset: -1,
            jurisdiction: 'US-NY',
          },
          {
            key: 'abroad',
            title: 'Example other item',
            phase: 'after',
            dayOffset: 40,
            jurisdiction: 'XE',
          },
        ],
        complaintAreas: [],
      },
    });
    const output = await expandChecklist.run(
      {
        track: 'example-noodle',
        jurisdiction: 'US',
        timezone: 'UTC',
        openingDate: '2024-03-01',
        updates: [],
      },
      { ...context(), assets: new MemorySource([tpl], SHARED_SLOTS) },
    );
    expect(output.output?.checklist.items.map((item) => [item.status, item.dueDate])).toEqual([
      ['todo', '2024-02-29'],
      ['skipped', '2024-04-10'],
    ]);
    expect(output.output?.checklist.lastDay).toBe(40);
  });
  it('reschedules only pending work and preserves completed dates', async () => {
    const output = await reschedule.run(
      {
        checklist: {
          ...checklist,
          items: [checklist.items[0], { ...checklist.items[0], key: 'later', status: 'doing' }],
        },
        openingDate: '2026-04-01',
      },
      context(),
    );
    expect(output.output?.items.map((item) => item.dueDate)).toEqual(['2026-02-27', '2026-03-30']);
  });
});

it('does not let a note turn an applicable non-waivable gate into skipped', async () => {
  const template = await sourceRecord('template', 'gate', {
    kind: 'opening-checklist',
    format: 'json',
    lang: 'en',
    title: { en: 'Example Gate' },
    content: {
      items: [
        {
          key: 'permit',
          title: 'Permit',
          phase: 'before',
          dayOffset: 0,
          gate: true,
          waivable: false,
          jurisdiction: 'XE',
        },
      ],
      complaintAreas: [],
    },
  });
  const output = await expandChecklist.run(
    {
      track: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      openingDate: '2026-03-01',
      updates: [{ key: 'permit', status: 'skipped', note: 'An attempted bypass' }],
    },
    { ...context(), assets: new MemorySource([template], SHARED_SLOTS) },
  );
  expect(output.output).toBeNull();
  expect(output.needs).toContainEqual(expect.objectContaining({ kind: 'input', blocking: true }));
});

it('closes the same punch issue when a new BuildPlan artifact version confirms repair', async () => {
  const { buildPlan } = await import('./lifecycle-fixtures.js');
  const first = await importUpstreamIssues.run(
    {
      issues: [],
      updates: [],
      buildPlan: await buildPlan('build-v1'),
      stockRequiredOn: '2026-03-01',
      timezone: 'UTC',
    },
    context(),
  );
  expect(first.output?.[0].status).toBe('open');
  const next = await importUpstreamIssues.run(
    {
      issues: first.output!,
      updates: [],
      buildPlan: await buildPlan('build-v2', true),
      stockRequiredOn: '2026-03-01',
      timezone: 'UTC',
    },
    context(),
  );
  expect(next.output).toHaveLength(1);
  expect(next.output?.[0].status).toBe('closed');
  expect(next.verifications).toEqual([]);
});
it('keeps inapplicable gates skipped despite upstream completion and permits manual receipt when its source is missing', async () => {
  const { buildPlan } = await import('./lifecycle-fixtures.js');
  const tpl = await sourceRecord('template', 'upstream-checks', {
    kind: 'opening-checklist',
    format: 'json',
    lang: 'en',
    title: { en: 'Example upstream checks' },
    content: {
      items: [
        {
          key: 'foreign',
          title: 'Foreign',
          phase: 'before',
          dayOffset: 0,
          gate: true,
          jurisdiction: 'US-NY',
          upstream: 'acceptance',
        },
        {
          key: 'stock',
          title: 'Stock',
          phase: 'before',
          dayOffset: 0,
          gate: true,
          upstream: 'openingStock',
        },
      ],
      complaintAreas: [],
    },
  });
  const output = await expandChecklist.run(
    {
      track: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      openingDate: '2026-03-01',
      buildPlan: await buildPlan('accepted', true),
      updates: [{ key: 'stock', status: 'done', note: 'Physical receipt checked manually' }],
    },
    { ...context(), assets: new MemorySource([tpl], SHARED_SLOTS) },
  );
  expect(output.output?.checklist.items.map((item) => item.status)).toEqual(['skipped', 'done']);
  expect(output.verifications).toEqual([]);
});

it('rejects a tampered upstream acceptance even when invoked as an independent checklist step', async () => {
  const { buildPlan } = await import('./lifecycle-fixtures.js');
  const upstream = await buildPlan('modified', true);
  upstream.body.acceptance.acceptedAt = '2026-02-28T00:00:00Z';
  const tpl = await sourceRecord('template', 'tamper-check', {
    kind: 'opening-checklist',
    format: 'json',
    lang: 'en',
    title: { en: 'Example' },
    content: {
      items: [
        {
          key: 'accept',
          title: 'Accept',
          phase: 'before',
          dayOffset: 0,
          gate: true,
          upstream: 'acceptance',
        },
      ],
      complaintAreas: [],
    },
  });
  const output = await expandChecklist.run(
    {
      track: 'example-noodle',
      jurisdiction: 'XE',
      timezone: 'UTC',
      openingDate: '2026-03-01',
      buildPlan: upstream,
      updates: [],
    },
    { ...context(), assets: new MemorySource([tpl], SHARED_SLOTS) },
  );
  expect(output.output).toBeNull();
  expect(output.needs).toContainEqual(
    expect.objectContaining({ path: 'BuildPlan.hash', blocking: true }),
  );
});
