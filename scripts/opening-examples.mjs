import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ArtifactEnvelope,
  BomBody,
  MemorySource,
  SHARED_SLOTS,
  assetRef,
  createParamReader,
  versionHash,
} from '@osw/core';
import { workflow } from '@osw/opening';
const NOW = '2026-01-01T00:00:00Z';
const ACTOR = 'example:reviewer';
// 与生产资产无关的独立合成数据，所有题目、金额、人物均从常数构造。
export async function openingAssets() {
  const records = [];
  const add = async (slot, id, data) => {
    const record = {
      slot,
      id,
      data,
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      updatedAt: NOW,
      coverage: {
        tier: 'track',
        tracks: ['example-noodle'],
        workflows: ['opening'],
        jurisdictions: ['XE'],
      },
      example: true,
    };
    records.push(record);
    return record;
  };
  await add('store', 'example-opening-store', {
    name: { en: 'Example Noodle Bar' },
    status: 'preparing',
    track: 'example-noodle',
    jurisdiction: 'XE',
    timezone: 'UTC',
  });
  await add('role', 'example-cook', {
    key: 'example-cook',
    standard: 'example-food',
    onboardWave: 'example-first',
    stationKey: 'example-hot',
    relief: false,
    names: { en: 'Example Cook' },
  });
  await add('cert', 'example-safety', {
    key: 'example-safety',
    standard: 'example-food',
    title: { en: 'Example Safety' },
    group: 'example-required',
    positions: ['example-cook'],
    critical: true,
    locked: true,
    requires: ['written', 'practical'],
    defaultChecks: ['example-clean'],
    recertMonths: 12,
  });
  await add('course', 'example-course', {
    key: 'example-course',
    rights: 'synthetic-public',
    version: '0.1.0',
    sourceDocs: [],
    units: [
      {
        id: 'example-boil',
        title: 'Example boiling method',
        station: 'example-hot',
        positions: ['example-cook'],
        critical: true,
        controls: ['example-observe'],
        covers: ['example-dish'],
      },
    ],
  });
  await add('exam', 'example-exam', {
    key: 'example-exam',
    certKey: 'example-safety',
    lang: 'en',
    version: '0.1.0',
    passScore: 60,
    questions: [
      {
        no: 1,
        points: 100,
        manual: false,
        prompt: 'Type the invented word EXAMPLE.',
        answer: 'EXAMPLE',
        rationale: 'Synthetic answer key',
        guide: 'Synthetic grading guide',
      },
    ],
  });
  await add('track-affinity', 'example-affinity', {
    track: 'example-noodle',
    borrowFrom: ['example-neighbor'],
  });
  const template = (id, kind, content) =>
    add('template', id, { kind, lang: 'en', title: { en: id }, format: 'json', content });
  await template('example-cert-plan', 'cert-plan', {
    standard: 'example-food',
    groups: ['example-required'],
    excludeKeys: [],
    checks: { 'example-safety': ['example-clean'] },
  });
  await template('example-opening-checklist', 'opening-checklist', {
    items: [
      {
        key: 'example-permit',
        title: 'Example permit evidence',
        phase: 'before',
        dayOffset: -1,
        gate: true,
        waivable: false,
        jurisdiction: 'XE',
      },
      {
        key: 'example-review',
        title: 'Example first-month review',
        phase: 'after',
        dayOffset: 30,
        gate: false,
        waivable: false,
        reviewCheckpoint: 'month',
      },
    ],
    complaintAreas: ['example-food'],
  });
  await template('example-marketing-plan', 'marketing-plan', {
    items: [
      {
        key: 'example-launch',
        channel: 'social',
        title: 'Example launch announcement',
        dayOffset: -1,
        deliverable: 'Example post',
        core: true,
        category: 'launch',
        stage: 'before',
      },
    ],
    creatorSelection: {
      tiers: ['micro'],
      formats: ['short'],
      audienceLanguages: ['en'],
      mixRoles: ['local'],
    },
    disclosureRules: [{ jurisdiction: 'XE', required: true }],
  });
  await template('example-asset-plan', 'asset-plan', {
    items: [{ key: 'example-photo', required: 2, channels: ['social'] }],
  });
  await add('party', 'example-creator', {
    name: { en: 'Example Creator' },
    roles: ['creator'],
    status: 'active',
    jurisdictions: ['XE'],
    languages: ['en'],
    profiles: {
      creator: {
        platform: 'example-platform',
        tier: 'micro',
        audience: 100,
        formats: ['short'],
        engagementPct: 10,
        lastPostOn: '2025-12-31',
        verifiedOn: '2025-12-31',
      },
    },
  });
  await add('content-case', 'example-content', {
    goal: 'intro',
    durationSec: 20,
    metrics: { plays: 100, likes: 10 },
    url: 'https://example.com/example-video',
  });
  await add('content-playbook', 'example-playbook', {
    weeks: [{ weekOffset: 0, count: 2, mix: { intro: 1 } }],
    scripts: { intro: ['Example kitchen', 'Example dish'] },
  });
  for (const [key, value] of Object.entries({
    'training.minPassScore': 60,
    'training.verify.minAttempts': 2,
    'training.verify.firstPassRateLow': 0.2,
    'training.verify.firstPassRateHigh': 0.8,
    'marketing.creator.activeWithinDays': 30,
    'marketing.creator.maxPostGapDays': 10,
    'marketing.creator.staleDays': 30,
    'marketing.creator.minEngagement.micro': 2,
    'marketing.creator.mixMin.local': 1,
    'marketing.creator.mixMax.local': 1,
    'marketing.budget.revenueRate': 0.1,
    'marketing.budget.reserveRate': 0.2,
    'marketing.budget.split.social': 1,
    'marketing.ads.stageWeight.before': 1,
  }))
    await add('params', key, { key, value });
  return records;
}
export async function openingExample(records, storeSpec) {
  const usd = (amount) => ({ amount, currency: 'USD' });
  const bomBody = BomBody.parse({
    currency: 'USD',
    lines: [
      {
        id: 'example-stock',
        lineKind: 'food',
        qty: 20,
        unit: 'pack',
        category: 'example-noodle',
        name: 'Example opening noodles',
        zone: 'example-kitchen',
        spec: 'Synthetic pack',
        qtyRule: { kind: 'manual' },
        qtyBasis: { status: 'manual', note: 'Invented fixture' },
        dimsBasis: { status: 'manual', note: 'Not dimensioned' },
        budgetKey: 'working_capital',
        evidence: [],
        derivedFrom: { kind: 'manual', ref: 'example:fixture' },
        pricingMode: 'whole',
        components: [],
        wholeEstimate: { unit: usd(10), basis: 'estimate' },
        modelCostPerUnit: null,
        parts: [],
        modelWarnings: [],
        sourcing: null,
        costBasis: 'model',
        unitPrice: { ...usd(10), basis: 'estimate' },
      },
    ],
    totals: {
      model: usd(200),
      chosen: usd(200),
      byBudgetKey: { working_capital: { model: usd(200), chosen: usd(200), sourcedShare: 0 } },
    },
  });
  const bom = ArtifactEnvelope('Bom', BomBody).parse({
    kind: 'Bom',
    artifactVersion: '0.1.0',
    id: 'example-opening-bom',
    hash: await versionHash(bomBody),
    storeId: storeSpec.storeId,
    producedBy: { step: 'fitout-bom/assembleBom', pkg: '@osw/fitout-bom', pkgVersion: '0.1.0' },
    createdAt: NOW,
    inputs: [],
    sources: [],
    body: bomBody,
    example: true,
  });
  const exam = records.find((record) => record.slot === 'exam');
  const seats = ['example-seat-a', 'example-seat-b'].map((seatId) => ({
    seatId,
    positionKey: 'example-cook',
    status: 'active',
  }));
  const assessments = seats.flatMap(({ seatId }) => [
    {
      seatId,
      certKey: 'example-safety',
      examRef: assetRef(exam),
      submission: {
        id: `${seatId}-written`,
        kind: 'written',
        by: ACTOR,
        answers: { 1: 'example' },
      },
    },
    {
      seatId,
      certKey: 'example-safety',
      submission: {
        id: `${seatId}-practical`,
        kind: 'practical',
        by: ACTOR,
        examiner: ACTOR,
        checks: { 'example-clean': 'pass' },
      },
    },
    {
      seatId,
      certKey: 'course:example-course:example-boil',
      submission: {
        id: `${seatId}-course`,
        kind: 'practical',
        by: ACTOR,
        examiner: ACTOR,
        checks: { 'example-observe': 'pass' },
      },
    },
  ]);
  const input = {
    storeSpec,
    bomRef: { kind: bom.kind, id: bom.id, hash: bom.hash },
    openingDate: '2026-01-01',
    languages: ['en'],
    seats,
    assessments,
    checklistUpdates: [
      { key: 'example-permit', status: 'done', note: 'Synthetic permit evidence reviewed' },
    ],
    transitions: ['ready', 'live'],
    handoff: true,
    marketing: {
      assetProgress: [{ key: 'example-photo', ready: 1 }],
      creatorFacts: [
        {
          partyId: 'example-creator',
          locality: { local: true, by: ACTOR },
          recentPostDates: ['2025-12-30', '2025-12-31'],
          audienceLanguages: ['en'],
          mixRole: 'local',
        },
      ],
    },
  };
  const approvals = [];
  const ctx = {
    assets: new MemorySource(records, [...SHARED_SLOTS, ...workflow.slots]),
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      NOW,
    ),
    approvals,
    providers: {},
    now: NOW,
    actor: ACTOR,
  };
  // 每轮审批来自真实运行返回的 subjectHash；只对本示例显式列出的人工闸签署。
  let result;
  for (let pass = 0; pass < 4; pass++) {
    result = await workflow.run(input, ctx);
    if (result.artifact) break;
    const gates = result.needs.filter((need) => need.kind === 'approval');
    if (!gates.length) throw new Error(`Opening example failed: ${JSON.stringify(result.needs)}`);
    for (const gate of gates) {
      const decisions = {
        'opening/signRelease': 'go',
        'opening/planMarketing': 'approved',
        'opening/handoff': 'operating',
      };
      const decision = decisions[gate.step];
      if (!decision) throw new Error(`Unexpected example gate ${gate.step}`);
      if (
        !approvals.some(
          (approval) => approval.step === gate.step && approval.subjectHash === gate.subjectHash,
        )
      )
        approvals.push({
          step: gate.step,
          subject: gate.subject,
          subjectHash: gate.subjectHash,
          decision,
          by: ACTOR,
          at: NOW,
          note: 'Synthetic reviewer confirmed the displayed evidence',
        });
    }
  }
  if (!result?.artifact)
    throw new Error(`Opening example did not complete: ${JSON.stringify(result?.needs)}`);
  return { input, bom, approvals, result, ctx };
}
export async function saveOpeningExample(directory, records, storeSpec) {
  const example = await openingExample(records, storeSpec);
  for (const [path, data] of Object.entries({
    'inputs/opening.json': example.input,
    'inputs/opening-bom.json': example.bom,
    'approvals/opening.json': example.approvals,
    'expected/opening-record.json': example.result.artifact,
  })) {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(resolve(directory, path), `${JSON.stringify(data, null, 2)}\n`);
  }
}
