import { assetRef, slotJsonSchema, z } from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import {
  CertPlanContent,
  PlanItem,
  buildCertPlan,
  checkSopCoverage,
  courseCertKey,
  deriveCertMatrix,
  pickMaterials,
  planStaffing,
  readiness,
  trainingSlots,
  trainingTransition,
} from '../src/training/index.js';
import {
  activeSeat,
  plannedStaffing,
  reference,
  sampleCert,
  sampleCourse,
  sampleRole,
  trainingContext,
  trainingNow,
  trainingRecord,
  trainingScope,
} from './training-fixtures.js';

async function planFixture(jurisdictions: string[] = []) {
  const template = await trainingRecord('template', 'example-plan', {
    kind: 'cert-plan',
    lang: 'en',
    title: { en: 'Example plan' },
    format: 'json',
    content: {
      standard: 'example-food',
      groups: ['essential'],
      excludeKeys: [],
      checks: { safety: ['clean', 'serve'] },
    },
  });
  const cert = await trainingRecord('cert', 'example-safety', sampleCert(), {
    coverage: { tier: 'general', tracks: [], workflows: [], jurisdictions },
  });
  const ctx = await trainingContext([template, cert]);
  return { ctx, template, cert };
}
const planItem = () =>
  PlanItem.parse({ ...sampleCert(), enabled: true, checks: ['clean', 'serve'] });

describe('opening training contracts and staffing', () => {
  it('exports JSON Schemas and uses a core-compatible slot name', () => {
    for (const slot of trainingSlots) expect(slotJsonSchema(slot)).toBeTruthy();
    expect(trainingSlots.map((s) => s.name)).toContain('track-affinity');
    expect(() =>
      CertPlanContent.parse({ standard: 'example', groups: [], excludeKeys: [] }),
    ).not.toThrow();
  });
  it('counts active seats and planned stations while ignoring departed seats', async () => {
    const records = [
      await trainingRecord('role', 'cook', sampleRole()),
      await trainingRecord('role', 'fryer', sampleRole('fryer', 'fry')),
    ];
    const result = await planStaffing.run(
      {
        ...trainingScope,
        staffing: [
          { positionKey: 'cook', headcount: 1 },
          { positionKey: 'fryer', headcount: 0 },
        ],
        seats: [activeSeat, { seatId: 'old', positionKey: 'fryer', status: 'left' }],
      },
      await trainingContext(records),
    );
    expect(result.output?.openStations).toEqual(['hot']);
    expect(result.output?.staffing).toEqual([
      { positionKey: 'cook', planned: 1, staffed: 1 },
      { positionKey: 'fryer', planned: 0, staffed: 0 },
    ]);
  });
  it('blocks missing role assets and duplicate seat ids', async () => {
    const ctx = await trainingContext();
    const result = await planStaffing.run(
      {
        ...trainingScope,
        staffing: [{ positionKey: 'cook', headcount: 1 }],
        seats: [activeSeat, activeSeat],
      },
      ctx,
    );
    expect(result.output).toBeNull();
    expect(result.needs.some((n) => n.kind === 'asset')).toBe(true);
  });
});

describe('certification plan safety', () => {
  it('keeps locked certifications even when excluded by the template', async () => {
    const { ctx, template } = await planFixture();
    const result = await buildCertPlan.run(
      { ...trainingScope, templateRef: assetRef(template) },
      ctx,
    );
    expect(result.output?.items[0]).toMatchObject({
      enabled: true,
      locked: true,
      checks: ['clean', 'serve'],
    });
    expect(result.output?.sources.some((r) => r.slot === 'params')).toBe(true);
  });
  it('rejects omitted or disabled locked items', async () => {
    const { ctx } = await planFixture();
    expect((await buildCertPlan.run({ ...trainingScope, items: [] }, ctx)).output).toBeNull();
    expect(
      (
        await buildCertPlan.run(
          { ...trainingScope, items: [{ ...planItem(), enabled: false }] },
          ctx,
        )
      ).output,
    ).toBeNull();
  });
  it('rejects weakened locked assessment requirements', async () => {
    const { ctx, cert } = await planFixture();
    const result = await buildCertPlan.run(
      { ...trainingScope, items: [{ ...planItem(), ref: assetRef(cert), requires: [] }] },
      ctx,
    );
    expect(result.output).toBeNull();
    expect(result.needs.some((n) => n.kind === 'input' && n.reason.includes('weakened'))).toBe(
      true,
    );
  });
  it('rejects a passing score below the configured minimum', async () => {
    const { ctx, cert } = await planFixture();
    const result = await buildCertPlan.run(
      { ...trainingScope, items: [{ ...planItem(), ref: assetRef(cert), passScore: 1 }] },
      ctx,
    );
    expect(result.output).toBeNull();
  });
  it('keeps an uncertain child jurisdiction and returns a manual confirmation need', async () => {
    const { ctx } = await planFixture(['US-NY']);
    const result = await buildCertPlan.run({ ...trainingScope, jurisdiction: 'US' }, ctx);
    expect(result.output?.items[0].enabled).toBe(true);
    expect(result.needs.some((n) => n.kind === 'input' && !n.blocking)).toBe(true);
  });
  it('does not guess missing or ambiguous parameters', async () => {
    const { template, cert } = await planFixture();
    const result = await buildCertPlan.run(
      trainingScope,
      await trainingContext([template, cert], {}),
    );
    expect(result.output).toBeNull();
    expect(result.needs).toContainEqual({
      kind: 'param',
      key: 'training.minPassScore',
      reason: 'missing',
      blocking: true,
    });
  });
  it('requires a choice between equally applicable templates', async () => {
    const { template, cert } = await planFixture();
    const second = { ...template, id: 'second-plan' };
    const result = await buildCertPlan.run(
      trainingScope,
      await trainingContext([template, second, cert]),
    );
    expect(result.output).toBeNull();
  });
});

describe('SOP coverage and the required certification matrix', () => {
  it('checks explicit dish ids, emits fails, and requests mappings', async () => {
    const menu = await trainingRecord('menu', 'menu', {
      title: { en: 'Example menu' },
      cuisine: 'example',
      tracks: ['example-track'],
      items: [
        { id: 'dish-one', name: { en: 'One' }, station: 'hot' },
        { id: 'dish-two', name: { en: 'Two' }, station: 'fry' },
      ],
    });
    const course = await trainingRecord('course', 'course', sampleCourse());
    const role = await trainingRecord('role', 'fryer', sampleRole('fryer', 'fry'));
    const result = await checkSopCoverage.run(
      { ...trainingScope, menuRef: assetRef(menu), openStations: ['hot'] },
      await trainingContext([menu, course, role]),
    );
    expect(result.output).toMatchObject({ covered: 1, total: 2, missing: ['dish-two'] });
    expect(
      result.verifications.some((v) => v.verdict === 'fails' && v.dimension === 'menuCoverage'),
    ).toBe(true);
    expect(result.verifications.some((v) => v.dimension === 'stationStaffed')).toBe(true);
    expect(result.needs.some((n) => n.kind === 'action' && n.action === 'mapDishToSop')).toBe(true);
  });
  it('refuses stale menu references', async () => {
    const menu = await trainingRecord('menu', 'menu', {
      title: { en: 'Example' },
      cuisine: 'example',
      tracks: [],
      items: [],
    });
    const result = await checkSopCoverage.run(
      {
        ...trainingScope,
        menuRef: { ...assetRef(menu), versionHash: 'b'.repeat(64) },
        openStations: [],
      },
      await trainingContext([menu]),
    );
    expect(result.output).toBeNull();
  });
  it('does not assign a closed fryer station certification to relief', async () => {
    const roles = [
      await trainingRecord('role', 'relief', sampleRole('relief', '', true)),
      await trainingRecord('role', 'fryer', sampleRole('fryer', 'fry')),
    ];
    const base = planItem();
    const result = await deriveCertMatrix.run(
      {
        ...trainingScope,
        staffing: [{ positionKey: 'relief', planned: 1, staffed: 1 }],
        seats: [{ ...activeSeat, positionKey: 'relief' }],
        openStations: ['hot'],
        plan: reference(),
        planItems: [
          base,
          { ...base, key: 'fry-cert', stationKey: 'fry', positions: ['fryer'], locked: false },
        ],
        cells: [],
      },
      await trainingContext(roles),
    );
    expect(result.output?.cells.map((c) => c.certKey)).toEqual(['safety']);
  });
  it('derives missing course cells and counts expired certificates on the due date', async () => {
    const records = [
      await trainingRecord('role', 'cook', sampleRole()),
      await trainingRecord('course', 'course', sampleCourse()),
    ];
    const result = await deriveCertMatrix.run(
      {
        ...trainingScope,
        staffing: plannedStaffing,
        seats: [activeSeat],
        openStations: ['hot'],
        plan: reference(),
        planItems: [planItem()],
        cells: [
          {
            seatId: 'seat-one',
            certKey: 'safety',
            critical: false,
            locked: false,
            state: 'passed',
            recertDue: '2026-03-01',
            attempts: 3,
          },
        ],
      },
      await trainingContext(records),
    );
    expect(result.output?.cells).toHaveLength(2);
    expect(result.output?.cells[0]).toMatchObject({
      state: 'expired',
      critical: true,
      locked: true,
    });
    expect(result.output?.cells[1].certKey).toBe(courseCertKey('course', 'hot-sop'));
    expect(result.output?.summary).toMatchObject({
      certRequired: 2,
      criticalRequired: 2,
      criticalPending: 2,
      ready: false,
    });
  });
  it('omits superseded plan items only when the replacement is enabled', async () => {
    const records = [await trainingRecord('role', 'cook', sampleRole())];
    const base = planItem();
    const input = {
      ...trainingScope,
      staffing: plannedStaffing,
      seats: [activeSeat],
      openStations: ['hot'],
      plan: reference(),
      planItems: [
        { ...base, key: 'old', supersededBy: ['new'] },
        { ...base, key: 'new' },
      ],
      cells: [],
    };
    const result = await deriveCertMatrix.run(input, await trainingContext(records));
    expect(result.output?.cells.map((c) => c.certKey)).toEqual(['new']);
  });
  it('uses the injected clock in the supplied timezone', async () => {
    const result = await readiness.run(
      {
        staffing: plannedStaffing,
        seats: [activeSeat],
        cells: [
          {
            seatId: 'seat-one',
            certKey: 'safety',
            critical: true,
            locked: true,
            state: 'passed',
            recertDue: '2026-03-01',
            attempts: 1,
          },
        ],
        timezone: 'America/New_York',
      },
      await trainingContext(),
    );
    expect(result.output?.summary.ready).toBe(true);
  });
  it('reports hollow and a null percentage when there are no required cells', async () => {
    const result = await readiness.run(
      { staffing: plannedStaffing, seats: [], cells: [], timezone: 'UTC' },
      await trainingContext(),
    );
    expect(result.output).toMatchObject({
      pct: null,
      summary: { hollow: true, ready: false, criticalRequired: 0 },
    });
  });
  it('training phases move one step and certification requires readiness', async () => {
    const ctx = await trainingContext();
    const summary = (
      await readiness.run({ staffing: [], seats: [], cells: [], timezone: 'UTC' }, ctx)
    ).output!.summary;
    expect(
      (await trainingTransition.run({ current: 'planning', target: 'coaching', summary }, ctx))
        .output,
    ).toBeNull();
    expect(
      (await trainingTransition.run({ current: 'drilling', target: 'certified', summary }, ctx))
        .output,
    ).toBeNull();
    expect(
      (await trainingTransition.run({ current: 'coaching', target: 'hiring', summary }, ctx))
        .output,
    ).toEqual({ status: 'hiring' });
  });
});

describe('material ranking', () => {
  it('retains rank-three fallback papers and pushes exam keys and languages down', async () => {
    const exam = await trainingRecord(
      'exam',
      'fallback',
      {
        key: 'fallback',
        certKey: 'safety',
        lang: 'en',
        version: 'v1',
        passScore: 60,
        questions: [{ no: 1, points: 100, manual: false, answer: 'invented' }],
      },
      { coverage: { tier: 'track', tracks: ['other-track'], jurisdictions: [], workflows: [] } },
    );
    const ctx = await trainingContext([exam]);
    const query = vi.spyOn(ctx.assets, 'query');
    const result = await pickMaterials.run(
      { track: 'example-track', certKeys: ['safety'], langs: ['en'] },
      ctx,
    );
    expect(result.output?.papers[0].rank).toBe(3);
    expect(
      query.mock.calls.some(
        ([slot, filter, opts]) =>
          slot.name === 'exam' &&
          JSON.stringify(filter).includes('certKey') &&
          JSON.stringify(filter).includes('lang') &&
          opts?.limit === 200,
      ),
    ).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain('invented');
  });
  it('keeps only the best rank within each certification and language', async () => {
    const base = {
      key: 'paper',
      certKey: 'safety',
      lang: 'en',
      version: 'v1',
      passScore: 60,
      questions: [{ no: 1, points: 100, manual: false, answer: 'invented' }],
    };
    const records = [
      await trainingRecord('exam', 'generic', base),
      await trainingRecord('exam', 'matching', base, {
        coverage: { tier: 'track', tracks: ['example-track'], workflows: [], jurisdictions: [] },
      }),
    ];
    const result = await pickMaterials.run(
      { track: 'example-track', certKeys: ['safety'], langs: ['en'] },
      await trainingContext(records),
    );
    expect(result.output?.papers.map((p) => p.ref.id)).toEqual(['matching']);
  });
});

it('queries only general, current-track and borrowed course materials', async () => {
  const course = sampleCourse();
  const records = [
    await trainingRecord('track-affinity', 'affinity', {
      track: 'example-track',
      borrowFrom: ['shared-track'],
    }),
    await trainingRecord('course', 'general-course', course),
    await trainingRecord('course', 'shared-course', course, {
      coverage: { tier: 'track', tracks: ['shared-track'], jurisdictions: [], workflows: [] },
    }),
    await trainingRecord('course', 'unrelated-course', course, {
      coverage: { tier: 'track', tracks: ['unrelated-track'], jurisdictions: [], workflows: [] },
    }),
  ];
  const ctx = await trainingContext(records);
  const query = vi.spyOn(ctx.assets, 'query');
  const result = await pickMaterials.run(
    { track: 'example-track', certKeys: ['safety'], langs: ['en'] },
    ctx,
  );
  expect(result.output?.courses.map((c) => c.ref.id)).toEqual(['general-course', 'shared-course']);
  expect(result.output?.courses[1].borrowedFrom).toBe('shared-track');
  expect(
    query.mock.calls
      .filter(([slot]) => slot.name === 'course')
      .every(([, filter]) => filter !== null && JSON.stringify(filter).includes('coverage.tracks')),
  ).toBe(true);
});

it('invalidates a passed course cell when its SOP source version changes', async () => {
  const oldCourse = await trainingRecord('course', 'course', sampleCourse());
  const updatedData = { ...sampleCourse(), version: 'example-v2' };
  updatedData.units[0] = { ...updatedData.units[0], controls: ['observe', 'verify'] };
  const updatedCourse = await trainingRecord('course', 'course', updatedData);
  const role = await trainingRecord('role', 'cook', sampleRole());
  const input = {
    ...trainingScope,
    staffing: plannedStaffing,
    seats: [activeSeat],
    openStations: ['hot'],
    plan: reference(),
    planItems: [planItem()],
    cells: [
      {
        seatId: activeSeat.seatId,
        certKey: courseCertKey('course', 'hot-sop'),
        critical: true,
        locked: false,
        state: 'passed' as const,
        attempts: 7,
        passedAt: '2026-02-20',
        recertDue: '2027-02-20',
        examiner: 'example:old-examiner',
        sop: { ...assetRef(oldCourse), path: '/units/0' },
      },
    ],
  };
  const unchanged = await deriveCertMatrix.run(input, await trainingContext([role, oldCourse]));
  expect(unchanged.output?.cells.find((cell) => cell.certKey.startsWith('course:'))).toMatchObject({
    state: 'passed',
    attempts: 7,
  });
  const changed = await deriveCertMatrix.run(input, await trainingContext([role, updatedCourse]));
  const cell = changed.output?.cells.find((cell) => cell.certKey.startsWith('course:'));
  expect(cell).toMatchObject({
    state: 'pending',
    attempts: 7,
    sop: { ...assetRef(updatedCourse), path: '/units/0' },
  });
  expect(cell).not.toHaveProperty('passedAt');
  expect(cell).not.toHaveProperty('recertDue');
  expect(cell).not.toHaveProperty('examiner');
});
