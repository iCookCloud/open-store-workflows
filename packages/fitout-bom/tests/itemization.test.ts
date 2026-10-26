import { assetRef, versionHash } from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import { importedItemizer } from '../src/providers/index.js';
import { openaiCompatibleItemizer } from '../src/providers/openai-compatible.js';
import type { ItemCandidate } from '../src/schema.js';
import { bomCaseSlot, designSlot, lineTemplateSlot } from '../src/slots/index.js';
import { identifyItems } from '../src/steps/identify-items.js';
import { reviewItems } from '../src/steps/review-items.js';
import { seedFromCase } from '../src/steps/seed-from-case.js';
import { approve, context, line, money, record } from './fixtures.js';
const candidate: ItemCandidate = {
  tempId: 'chair-1',
  name: 'Example Chair',
  zone: 'Dining',
  spec: 'Example',
  lineKind: 'furniture',
  pricingMode: 'custom',
  dimensionsMm: { l: 500, w: 500, h: 800 },
  qty: 2,
  unit: 'pcs',
  componentsHint: [],
  evidence: [{ imageIndex: 0 }],
  estimated: { dims: false, qty: false },
  note: 'Synthetic',
};
async function setup() {
  const design = await record(designSlot, 'example-design', {
    kind: 'render',
    images: [{ url: 'https://example.com/image.png', sha256: '1'.repeat(64), aiGenerated: true }],
    hotspots: [],
  });
  const template = await record(lineTemplateSlot, 'example-template', {
    shape: 'components',
    lineKind: 'furniture',
    category: 'furniture.chair',
    budgetKey: 'furnishing',
    defaults: { geometry: {}, waste: 0, laborRate: money(0), minLabor: money(0), complexity: 1 },
    components: line().components,
  });
  return { design, template, ctx: context([design, template]) };
}
describe('itemization and review gates', () => {
  it('reports an absent provider and caches only identical provider content', async () => {
    const { design, ctx } = await setup();
    const input = { designId: design.id, track: 'example' };
    expect((await identifyItems(input, ctx)).needs.some((n) => n.kind === 'provider')).toBe(true);
    const cache = new Map<string, unknown>();
    const itemizer = importedItemizer([candidate]);
    const call = vi.spyOn(itemizer, 'itemize');
    ctx.providers.itemizer = itemizer;
    ctx.stores = {
      cache: {
        get: async (key) => cache.get(key),
        put: async (key, value) => {
          cache.set(key, value);
        },
      },
      quota: { consume: async () => true },
    };
    const a = await identifyItems(input, ctx);
    await identifyItems(input, ctx);
    expect(call).toHaveBeenCalledTimes(1);
    expect(a.output?.candidates[0].estimated).toEqual({ dims: true, qty: true });
    ctx.providers.itemizer = importedItemizer([{ ...candidate, qty: 3 }]);
    expect((await identifyItems(input, ctx)).output?.candidates[0].qty).toBe(3);
  });
  it('uses imported JSON and CSV without requiring a network provider', async () => {
    const { ctx, design } = await setup();
    expect(
      (await identifyItems({ designId: design.id, track: 'example', candidates: [candidate] }, ctx))
        .output?.candidates,
    ).toHaveLength(1);
    const headers = Object.keys(candidate);
    const values = Object.values(candidate).map((v) =>
      typeof v === 'object' ? JSON.stringify(v) : String(v),
    );
    const csv = [
      headers.join(','),
      values.map((v) => `"${v.replaceAll('"', '""')}"`).join(','),
    ].join('\n');
    expect(
      (
        await importedItemizer(csv).itemize({ images: [], track: 'example', promptVersion: 'v1' })
      )[0],
    ).toEqual(candidate);
  });
  it('needs review approval, preserves AI provenance, and invalidates an old approval after edits', async () => {
    const { ctx, design, template } = await setup();
    const identified = (
      await identifyItems({ designId: design.id, track: 'example', candidates: [candidate] }, ctx)
    ).output!;
    const input = {
      identification: identified,
      decisions: [
        {
          action: 'accept' as const,
          candidateIds: [candidate.tempId],
          outputs: [{ key: 'one', candidate, templateId: template.id }],
        },
      ],
      currency: 'USD',
      storeId: null,
    };
    const first = await reviewItems(input, ctx);
    expect(first.output).toBeNull();
    ctx.approvals = approve(first.needs);
    const second = await reviewItems(input, ctx);
    expect(second.output?.lines[0].qtyBasis.status).toBe('estimated');
    expect(second.output?.lines[0].dimsBasis.status).toBe('estimated');
    const changed = structuredClone(input);
    changed.decisions[0].outputs[0].candidate.qty = 4;
    expect((await reviewItems(changed, ctx)).output).toBeNull();
  });
  it('merge/split identifiers are stable when decisions reorder', async () => {
    const { ctx, design, template } = await setup();
    const other = { ...candidate, tempId: 'chair-2' };
    const third = { ...candidate, tempId: 'chair-3' };
    const identified = (
      await identifyItems(
        { designId: design.id, track: 'example', candidates: [candidate, other, third] },
        ctx,
      )
    ).output!;
    const decisions = [
      {
        action: 'merge' as const,
        candidateIds: ['chair-1', 'chair-2'],
        outputs: [{ key: 'merged', candidate, templateId: template.id }],
      },
      {
        action: 'split' as const,
        candidateIds: ['chair-3'],
        outputs: [
          { key: 'left', candidate: third, templateId: template.id },
          { key: 'right', candidate: third, templateId: template.id },
        ],
      },
    ];
    const input = { identification: identified, decisions, currency: 'USD', storeId: null };
    ctx.approvals = approve((await reviewItems(input, ctx)).needs);
    const ids = (await reviewItems(input, ctx)).output!.lines.map((l) => l.id).sort();
    const reversed = { ...input, decisions: [...decisions].reverse() };
    ctx.approvals = approve((await reviewItems(reversed, ctx)).needs);
    expect((await reviewItems(reversed, ctx)).output!.lines.map((l) => l.id).sort()).toEqual(ids);
  });
  it('seed remaps linked IDs without reusing a case supplier selection', async () => {
    const caseRecord = await record(bomCaseSlot, 'example-case', {
      title: 'Example Case',
      designRefs: [],
      lines: [
        line(),
        line({ id: 'second', qtyRule: { kind: 'linked', links: ['sample-line'], factor: 1 } }),
      ],
    });
    const out = await seedFromCase(
      { caseId: caseRecord.id, storeId: 'example-store' },
      context([caseRecord]),
    );
    expect(out.output?.lines[0].id).not.toBe('sample-line');
    expect(out.output?.lines[1].qtyRule).toEqual({
      kind: 'linked',
      links: [out.output?.lines[0].id],
      factor: 1,
    });
    expect(out.output?.sources[0]).toEqual(assetRef(caseRecord));
  });
  it('enforces remote quota before making a request and validates provider responses', async () => {
    const { ctx, design } = await setup();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ items: [candidate] }) } }],
          }),
          { status: 200 },
        ),
    );
    const provider = openaiCompatibleItemizer({
      fetch,
      baseUrl: 'https://example.com/v1',
      model: 'example',
      apiKey: 'example-token',
      quota: { limit: 1, windowSec: 60 },
    });
    ctx.providers.itemizer = provider;
    ctx.stores = {
      cache: { get: async () => undefined, put: async () => {} },
      quota: { consume: async () => false },
    };
    expect((await identifyItems({ designId: design.id, track: 'example' }, ctx)).output).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    ctx.stores.quota.consume = async () => true;
    expect(
      (await identifyItems({ designId: design.id, track: 'example' }, ctx)).output?.candidates,
    ).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
