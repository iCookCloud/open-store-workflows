import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArtifactEnvelope,
  BomBody,
  MemorySource,
  OpeningRecordBody,
  SHARED_SLOTS,
  assetRef,
  createParamReader,
  fieldsetHash,
  versionHash,
} from '@osw/core';
import { readExampleJson, writeExampleJson } from '@osw/core/node';
import { admitFromOpening, workflow } from '@osw/replenishment';
import { MemoryMailProvider, MemorySupplyLedger, runCampaignSend } from '@osw/replenishment/runner';

export const exampleDirectory = fileURLToPath(new URL('../examples/', import.meta.url));
const upstreamDirectory = fileURLToPath(new URL('../examples/upstream/', import.meta.url));
const seedsPath = fileURLToPath(
  new URL('../examples/seeds/unclassified-stores.json', import.meta.url),
);

export const REPLENISHMENT_NOW = '2026-02-02T12:00:00Z';
export const REPLENISHMENT_ACTOR = 'example:operator';
const openedAt = '2026-01-01T12:00:00Z';
const track = 'replenishment-noodle';
const usd = (amount) => ({ amount, currency: 'USD' });

// 所有值均从虚构常数构造；与任何实际门店、报价或收件库无关。
export async function replenishmentExample({ includeUnclassified = false } = {}) {
  const records = includeUnclassified ? (await readExampleJson(seedsPath)).items : [];
  const add = async (slot, id, data, frequency) => {
    const definition = [...SHARED_SLOTS, ...workflow.slots].find((entry) => entry.name === slot);
    const fieldsetHashes = Object.fromEntries(
      await Promise.all(
        Object.entries(definition?.fieldsets ?? {}).map(async ([key, fields]) => [
          key,
          await fieldsetHash(data, fields),
        ]),
      ),
    );
    const record = {
      slot,
      id,
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      ...(Object.keys(fieldsetHashes).length ? { fieldsetHashes } : {}),
      coverage: {
        tier: 'track',
        tracks: [track],
        workflows: ['replenishment'],
        jurisdictions: ['XE'],
        ...(frequency ? { frequency } : {}),
      },
      updatedAt: REPLENISHMENT_NOW,
      example: true,
      data,
    };
    records.push(record);
    return record;
  };
  const rules = await add('segment-ruleset', 'example-supply-rules', {
    segmentRegions: ['XE-A'],
    regionTiers: { central: ['XE-A'] },
    supplyCats: ['ingredients'],
    trackSupply: { [track]: ['ingredients'] },
    categoryAliases: { 'example noodle bar': track },
  });
  const supplier = await add('party', 'example-supply-partner', {
    name: { en: 'Example Supply Partner' },
    roles: ['supplier'],
    status: 'active',
    jurisdictions: ['XE'],
    profiles: { supplier: { supplyCats: ['ingredients'], acceptsSmallOrders: true } },
  });
  const products = [];
  for (const [id, name] of [
    ['example-supply-noodle', 'Example Noodles'],
    ['example-supply-broth', 'Example Broth'],
  ])
    products.push(
      await add(
        'product',
        id,
        {
          name: { en: name },
          kind: 'catalog',
          category: 'ingredients',
          goodsClass: 'food',
          status: 'active',
          spec: 'Example 1 kg bag',
        },
        'recurring',
      ),
    );
  const initial = await add('offer', 'example-supply-initial', {
    partyId: supplier.id,
    productId: products[0].id,
    basis: 'invoice',
    use: 'project',
    currency: 'USD',
    unit: 'kg',
    tiers: [{ minQty: 0, unitPrice: 30 }],
    quotedAt: '2026-01-01',
  });
  const repeat = await add('offer', 'example-supply-repeat', {
    partyId: supplier.id,
    productId: products[0].id,
    basis: 'catalog',
    use: 'repeat',
    currency: 'USD',
    unit: 'kg',
    tiers: [
      { minQty: 0, unitPrice: 30 },
      { minQty: 10, unitPrice: 20 },
    ],
    moq: 10,
    quotedAt: '2026-01-01',
  });
  const recipe = await add('recipe', 'example-supply-recipe', {
    name: { en: 'Example Noodle Bowl' },
    yield: { value: 1, unit: 'pcs' },
    ingredients: products.map((product) => ({ productId: product.id, qty: 1, unit: 'kg' })),
  });
  const menu = await add('menu', 'example-supply-menu', {
    title: { en: 'Example Operating Menu' },
    cuisine: 'replenishment-noodle',
    tracks: [track],
    items: [{ id: 'example-bowl', name: { en: 'Example Bowl' }, recipeId: recipe.id }],
  });
  const stores = [];
  for (const [index, jurisdiction] of ['XE-A-AA', 'XE-A-BB'].entries()) {
    const store = await add('store', `example-supply-store-${index + 1}`, {
      name: { en: index === 0 ? 'Example Noodle Bar' : 'Example Intake Noodle Bar' },
      status: 'operating',
      origin: index === 0 ? 'opened' : 'intake',
      track,
      jurisdiction,
      timezone: 'UTC',
      openedAt: '2026-01-01',
      supplyCategories: index === 0 ? ['outdated-example-category'] : ['ingredients'],
    });
    stores.push(store);
    await add('store-contact', `example-supply-contact-${index + 1}`, {
      storeId: store.id,
      channel: 'email',
      address: `supply-${index + 1}@example.com`,
      verdict: 'verified',
      source: 'synthetic-example',
      verifiedAt: openedAt,
      createdAt: openedAt,
    });
  }
  const lead = await add('template', 'example-supply-lead', {
    kind: 'newsletter-block',
    lang: 'en',
    title: { en: 'Example Supply Introduction' },
    format: 'markdown',
    body: 'Hello {{STORE}}, explore recurring ingredients for your menu.',
  });
  const service = await add('template', 'example-supply-service', {
    kind: 'newsletter-block',
    lang: 'en',
    title: { en: 'Example Supply Service' },
    format: 'markdown',
    body: 'Choose quantities in your store page: {{STORE_URL}}',
  });
  const footer = await add('template', 'example-supply-footer', {
    kind: 'newsletter-block',
    lang: 'en',
    title: { en: 'Example Supply Footer' },
    format: 'markdown',
    body: 'Unsubscribe: {{UNSUB}}',
  });
  const paramValues = {
    'nl.matrix.maxDims': 3,
    'nl.matrix.minCell': 1,
    'nl.capDays': 10,
    'nl.runMax': 20,
    'nl.dayMax': 100,
    'nl.trial': 10,
    'nl.holdHours': 10,
    'nl.window.tz': 'UTC',
    'nl.window.days': 'Mon,Tue,Wed,Thu,Fri',
    'nl.window.fromHour': 0,
    'nl.window.toHour': 24,
    'nl.breaker.complaint': 0,
    'nl.breaker.unsub': 0.1,
    'nl.breaker.bounce': 0.1,
    'nl.breaker.failed': 0.2,
    'nl.breaker.minSample': 10,
    'nl.breaker.minAttempts': 10,
    'nl.attributionDays': 30,
    'nl.provider.minIntervalMs': 10,
    'reorder.minIntervals': 2,
    'reorder.graceDays': 2,
    'program.shareWindowDays': 30,
    'program.shareTarget': 0.8,
    'verify.menu.windowDays': 30,
    'verify.menu.minShare': 0.8,
    'verify.price.tolerance': 0.1,
    'verify.segment.minSample': 10,
    'verify.segment.minReplyRate': 0.1,
  };
  for (const [key, value] of Object.entries(paramValues))
    await add('params', `example-supply-param-${key}`, { key, value });
  const seed = {
    id: 'example-noodle-line',
    lineKind: 'food',
    qty: 10,
    unit: 'kg',
    key: products[0].id,
    weakKey: false,
    name: 'Example Noodles',
    spec: 'Example 1 kg bag',
    productRef: assetRef(products[0]),
    offerRef: assetRef(initial),
    initialOfferRef: assetRef(initial),
    unitPrice: usd(30),
    priceSource: 'last-paid',
    coverDays: 10,
  };
  for (const day of [10, 20, 30]) {
    const at = `2026-01-${day}T12:00:00Z`;
    const lines = [
      { ...seed, offerRef: assetRef(repeat), unitPrice: usd(20), priceSource: 'repeat-offer' },
    ];
    const subjectHash = await versionHash(lines);
    await add('reorder', `example-supply-order-${day}`, {
      storeId: stores[0].id,
      supplierId: supplier.id,
      lines,
      skipped: [],
      state: 'delivered',
      history: ['draft', 'submitted', 'confirmed', 'delivered'].map((state) => ({
        state,
        at,
        by: REPLENISHMENT_ACTOR,
        subjectHash,
      })),
      receipt: [{ key: seed.key, qty: 10 }],
    });
  }
  const bom = ArtifactEnvelope('Bom', BomBody).parse(
    await readExampleJson(resolve(upstreamDirectory, 'bom.json')),
  );
  const opening = ArtifactEnvelope('OpeningRecord', OpeningRecordBody).parse(
    await readExampleJson(resolve(upstreamDirectory, 'opening-record.json')),
  );
  const base = { rulesetId: rules.id, opening, bom };
  const campaignInput = {
    ...base,
    mode: 'campaign',
    campaign: {
      campaignId: 'example-supply-campaign',
      supplierId: supplier.id,
      topicKey: 'example-recurring-ingredients',
      topicRule: { tracks: [track], regions: ['XE-A'] },
      dims: [{ key: 'scene', values: ['ingredients'] }],
      variants: [
        {
          variantKey: 'ingredients',
          cell: { scene: 'ingredients' },
          rule: { tracks: [track], regions: ['XE-A'] },
          lead: assetRef(lead),
          service: assetRef(service),
          productIds: [products[0].id],
          subject: 'Example recurring ingredients',
          preheader: 'An invented supply program',
          expected: 0,
        },
      ],
      sharedBlocks: [assetRef(footer)],
    },
  };
  const verification = {
    storeId: stores[0].id,
    openedAt,
    menuRef: assetRef(menu),
    seedLines: [seed],
    initialArrivedAt: openedAt,
  };
  const reorderInput = {
    ...base,
    mode: 'reorder',
    storeId: stores[0].id,
    currency: 'USD',
    selected: [{ line: seed, supplierId: supplier.id }],
    action: 'submit',
    verification,
  };
  const context = {
    assets: new MemorySource(records, workflow.slots),
    params: createParamReader(
      records.filter((record) => record.slot === 'params'),
      REPLENISHMENT_NOW,
    ),
    approvals: [],
    providers: {},
    now: REPLENISHMENT_NOW,
    actor: REPLENISHMENT_ACTOR,
  };
  await admitFromOpening.run({ opening, bom }, context);
  return { records, campaignInput, reorderInput, context };
}

export async function generateReplenishmentExamples(directory = exampleDirectory) {
  const fixture = await replenishmentExample({ includeUnclassified: true });
  const records = fixture.records;
  fixture.context.assets = new MemorySource(records, workflow.slots);
  const save = async (path, data) => {
    await mkdir(resolve(directory, path, '..'), { recursive: true });
    await writeFile(resolve(directory, path), `${JSON.stringify(data, null, 2)}\n`);
  };
  for (const slot of new Set(records.map((record) => record.slot)))
    await save(`assets/${slot}.json`, {
      $example: 'synthetic',
      items: records.filter((record) => record.slot === slot),
    });
  for (const name of ['bom', 'opening-record'])
    await writeExampleJson(
      resolve(directory, 'upstream', `${name}.json`),
      await readExampleJson(resolve(upstreamDirectory, `${name}.json`)),
    );
  await writeExampleJson(
    resolve(directory, 'seeds/unclassified-stores.json'),
    await readExampleJson(seedsPath),
  );
  for (const [name, input] of [
    ['replenishment', fixture.campaignInput],
    ['replenishment-reorder', fixture.reorderInput],
  ]) {
    const pending = await workflow.run(input, fixture.context);
    const approvals = pending.needs
      .filter((need) => need.kind === 'approval')
      .map((need) => ({
        step: need.step,
        subject: need.subject,
        subjectHash: need.subjectHash,
        decision: need.step === 'replenishment/selectAudience' ? 'send' : 'submit',
        ...(need.step === 'replenishment/advanceReorder' ? { role: 'store' } : {}),
        by: REPLENISHMENT_ACTOR,
        at: REPLENISHMENT_NOW,
      }));
    if (!approvals.length)
      throw new Error(`Example must reach an approval gate: ${JSON.stringify(pending.needs)}`);
    const completed = await workflow.run(input, { ...fixture.context, approvals });
    if (!completed.artifact || completed.needs.some((need) => need.blocking))
      throw new Error(`Replenishment example failed: ${JSON.stringify(completed.needs)}`);
    await save(`inputs/${name}.json`, input);
    await save(`approvals/${name}.json`, approvals);
    await save(`expected/${name}.json`, completed.artifact);
    if (name === 'replenishment') {
      const campaign = completed.artifact.body.campaigns[0];
      const ledger = new MemorySupplyLedger({ now: REPLENISHMENT_NOW, campaigns: [campaign] });
      const sent = await runCampaignSend(
        { campaign, rulesetId: input.rulesetId },
        { ...fixture.context, approvals },
        {
          provider: new MemoryMailProvider(),
          ledger,
          from: 'newsletter@example.com',
          unsubscribeBaseUrl: 'https://example.com/unsubscribe',
          unsubscribeSecret: 'invented-example-unsubscribe-key',
          storeUrl: (storeId) => `https://example.com/stores/${storeId}`,
        },
      );
      if (sent.output?.sent !== 2)
        throw new Error(
          `Memory sender did not send both synthetic messages: ${JSON.stringify(sent.needs)}`,
        );
      await writeFile(
        resolve(directory, 'expected/replenishment-send-log.ndjson'),
        `${[JSON.stringify({ $example: 'synthetic' }), ...ledger.snapshot().sendLogs.map((log) => JSON.stringify(log))].join('\n')}\n`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await generateReplenishmentExamples(
    process.argv[2] ? resolve(process.argv[2]) : exampleDirectory,
  );
