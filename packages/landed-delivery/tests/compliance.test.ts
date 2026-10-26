import { versionHash } from '@osw/core';
import { describe, expect, it, vi } from 'vitest';
import { mergeChain } from '../src/compliance/merge-chain.js';
import { resolveCategories } from '../src/compliance/resolve.js';
import { screenCompliance } from '../src/steps/screen-compliance.js';
import { approvedDelivery, deliveryFixture, rebuild } from './fixtures.js';

describe('compliance lineage and fail-closed resolution', () => {
  it('supports additions, overrides, retirement and deeper reinstatement', async () => {
    const fixture = await deliveryFixture();
    const base = fixture.records.find((record) => record.id === 'example-certificate')!;
    const change = (id: string, overrideOf: string | null, retired = false) => ({
      ...base,
      id,
      data: { ...base.data, overrideOf, retired },
    });
    const output = mergeChain(
      [[change('root', null)], [change('child', 'root', true)], [change('leaf', 'child')]],
      'XE',
    );
    expect(output.items.map((item) => [item.rootId, item.lineage, item.record.id])).toEqual([
      ['root', ['root', 'child', 'leaf'], 'leaf'],
    ]);
  });
  it('rejects orphan and same-layer duplicate overrides without choosing one', async () => {
    const fixture = await deliveryFixture();
    const base = fixture.records.find((record) => record.id === 'example-certificate')!;
    const change = (id: string, overrideOf: string | null) => ({
      ...base,
      id,
      data: { ...base.data, overrideOf },
    });
    const output = mergeChain(
      [
        [change('root', null)],
        [change('a', 'root'), change('b', 'root'), change('orphan', 'missing')],
      ],
      'XE',
    );
    expect(output.orphans).toEqual(['a', 'b', 'orphan']);
    expect(output.items[0].record.id).toBe('root');
  });
  it('applies jurisdiction prefixes at segment boundaries', async () => {
    const fixture = await deliveryFixture();
    const base = fixture.records.find((record) => record.id === 'example-certificate')!;
    expect(
      mergeChain([[{ ...base, data: { ...base.data, jurisdiction: 'XE-AB' } }]], 'XE-ABC').items,
    ).toHaveLength(0);
    expect(
      mergeChain([[{ ...base, data: { ...base.data, jurisdiction: 'XE-AB' } }]], 'XE-AB-CITY')
        .items,
    ).toHaveLength(1);
  });
  it.each([
    'missing_category',
    'missing_parent',
    'cycle',
    'too_deep',
    'cross_market',
    'item_market_mismatch',
  ] as const)('reports %s rather than an empty checklist', async (kind) => {
    const fixture = await deliveryFixture();
    const category = fixture.records.find((record) => record.id === 'example-category')!;
    let id = category.id;
    if (kind === 'missing_category') id = 'absent';
    if (kind === 'missing_parent') category.data.parentId = 'absent';
    if (kind === 'cycle') category.data.parentId = category.id;
    if (kind === 'cross_market') category.data.market = 'XF';
    if (kind === 'item_market_mismatch')
      fixture.records.find((record) => record.id === 'example-certificate')!.data.market = 'XF';
    if (kind === 'too_deep') {
      category.data.parentId = 'parent-1';
      for (let depth = 1; depth <= 6; depth++)
        fixture.records.push({
          ...category,
          id: `parent-${depth}`,
          data: { ...category.data, parentId: depth === 6 ? null : `parent-${depth + 1}` },
        });
    }
    await rebuild(fixture);
    const resolved = await resolveCategories([id], 'XE', 'XE', fixture.ctx);
    expect(resolved.get(id)?.tree).toBe(kind);
  });
  it('resolves a shared category once using bounded queries', async () => {
    const fixture = await deliveryFixture();
    const query = vi.spyOn(fixture.source, 'query');
    await screenCompliance.run(fixture.input, fixture.ctx);
    expect(query.mock.calls.filter(([slot]) => slot.name === 'compliance-category')).toHaveLength(
      1,
    );
    expect(query.mock.calls.filter(([slot]) => slot.name === 'compliance-item')).toHaveLength(1);
    expect(query.mock.calls.every(([, , options]) => (options?.limit ?? 200) <= 200)).toBe(true);
  });
});

describe('admission approvals', () => {
  it('blocks without a matching human decision and validates a supplied artifact hash', async () => {
    const fixture = await deliveryFixture();
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.output).toBeNull();
    expect(result.needs.filter((need) => need.kind === 'approval')).toHaveLength(6);
    fixture.input.bom.body.lines[0].qty = 9;
    const changed = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(changed.needs).toContainEqual(expect.objectContaining({ kind: 'input', path: 'Bom' }));
  });
  it('holds denied products and records a failed access verification', async () => {
    const fixture = await approvedDelivery();
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.output?.plan.held).toContainEqual(
      expect.objectContaining({ bomLineId: 'example-denied', reason: 'compliance_deny' }),
    );
    expect(result.verifications).toContainEqual(
      expect.objectContaining({ dimension: 'access', verdict: 'fails' }),
    );
  });
  it('expires evidence against expected arrival and rejects enter with open mandatory items', async () => {
    const fixture = await deliveryFixture();
    fixture.records.find((record) => record.id === 'example-cooker-answer')!.data.validUntil =
      '2026-01-10';
    await rebuild(fixture);
    const pending = await screenCompliance.run(fixture.input, fixture.ctx);
    for (const need of pending.needs)
      if (need.kind === 'approval')
        fixture.ctx.approvals.push({
          step: need.step,
          subject: need.subject,
          subjectHash: need.subjectHash,
          decision: 'enter',
          role: 'reviewer',
          by: 'example:test',
          at: fixture.ctx.now,
        });
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.output).toBeNull();
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'resolveCompliance' }),
    );
  });
  it('invalidates approval when an answer version changes even with the same cited status', async () => {
    const fixture = await approvedDelivery();
    fixture.records.find((record) => record.id === 'example-cooker-answer')!.data.by =
      'example:another-reviewer';
    await rebuild(fixture);
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: 'product:example-cooker@XE' }),
    );
  });
  it('rejects a fake lawyer and excludes future approvals', async () => {
    const fixture = await approvedDelivery();
    const entry = fixture.ctx.approvals.find(
      (approval) => approval.subject === 'product:example-cooker@XE',
    )!;
    entry.role = 'lawyer';
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'input', path: 'approvals.party' }),
    );
    entry.role = 'reviewer';
    entry.at = '2027-01-01T00:00:00Z';
    expect((await screenCompliance.run(fixture.input, fixture.ctx)).needs).toContainEqual(
      expect.objectContaining({ kind: 'approval', subject: entry.subject }),
    );
  });
  it('does not count batch documents as SKU evidence or admit a missing classification', async () => {
    const fixture = await approvedDelivery();
    const result = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(result.output?.plan.compliance[0].open.mandatory).toBe(0);
    expect(
      result.output?.plan.compliance[0].items.some(
        (item) => item.level === 'batch' && item.state === 'unanswered',
      ),
    ).toBe(true);
    fixture.records = fixture.records.filter(
      (record) => record.id !== 'example-cooker-classification',
    );
    await rebuild(fixture);
    const held = await screenCompliance.run(fixture.input, fixture.ctx);
    expect(
      held.output?.plan.compliance.find((entry) => entry.productRef.id === 'example-cooker')?.tree,
    ).toBe('unclassified');
    expect(held.output?.plan.held).toContainEqual(
      expect.objectContaining({ bomLineId: 'example-cooker', reason: 'compliance_pending' }),
    );
  });
});
