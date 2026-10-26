import {
  type Filter,
  type Need,
  OswSourceError,
  type StepDef,
  StoreSlot,
  type Verification,
  assetRef,
  canonicalJson,
  isWithin,
  z,
} from '@osw/core';
import { blocked, queryAll, result } from './helpers.js';
import { type SegmentRuleset, Segmentation } from './models.js';
import { segmentRulesetSlot } from './slots.js';

export function segmentRegion(jurisdiction: string, ruleset: SegmentRuleset): string | undefined {
  return [...ruleset.segmentRegions]
    .filter((prefix) => isWithin(jurisdiction, prefix))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0];
}
export function segmentFilter(region: string, track: string, ruleset: SegmentRuleset): Filter {
  // 排除更长分群前缀，确保重放时同一家店只属于一组。
  const descendants = ruleset.segmentRegions.filter(
    (prefix) => prefix !== region && isWithin(prefix, region),
  );
  return {
    all: [
      { field: 'status', op: 'eq', value: 'operating' },
      { field: 'track', op: 'eq', value: track },
      { field: 'jurisdiction', op: 'prefix', value: region },
      ...descendants.map(
        (prefix): Filter => ({ not: { field: 'jurisdiction', op: 'prefix', value: prefix } }),
      ),
    ],
  };
}
const Input = z.object({ rulesetId: z.string().min(1) });
export const classifyStores: StepDef<typeof Input, typeof Segmentation> = {
  id: 'replenishment/classifyStores',
  input: Input,
  output: Segmentation,
  reads: ['store', 'segment-ruleset'],
  params: [],
  async run(input, ctx) {
    const ruleset = await ctx.assets.get(segmentRulesetSlot, input.rulesetId);
    if (!ruleset)
      return blocked([
        {
          kind: 'asset',
          slot: 'segment-ruleset',
          filter: { field: 'id', op: 'eq', value: input.rulesetId },
          reason: 'Segment ruleset not found',
          blocking: true,
        },
      ]);
    const filter: Filter = { field: 'status', op: 'eq', value: 'operating' };
    let counts: { key: (string | number | boolean)[]; n: number }[] | undefined;
    if (ctx.assets.count) {
      try {
        const groups = await ctx.assets.count(StoreSlot, filter, {
          groupBy: ['jurisdiction', 'track'],
        });
        if (groups.length <= 1000) counts = groups;
      } catch (error) {
        if (
          !(error instanceof OswSourceError) ||
          !['unsupported', 'count_unsupported', 'filter_unsupported', 'too_many'].includes(
            error.code,
          )
        )
          throw error;
      }
    }
    // 即使有聚合能力也逐页检查记录的派生投影；聚合不能发现 supplyCategories 漂移。
    const stores = await queryAll(ctx.assets, StoreSlot, filter);
    if (ruleset.redacted?.length || stores.some((r) => r.redacted?.length))
      return blocked([
        {
          kind: 'asset',
          slot: 'store',
          filter,
          reason: 'Classification requires unredacted store and ruleset fields',
          blocking: true,
        },
      ]);
    if (
      ruleset.data.segmentRegions.some(
        (region) =>
          ruleset.data.segmentRegions.filter((p) => p !== region && isWithin(p, region)).length >
          29,
      )
    )
      return blocked([
        {
          kind: 'input',
          path: 'ruleset.segmentRegions',
          reason: 'Too many nested regions for a replayable core filter',
          blocking: true,
        },
      ]);
    const groups = new Map<string, { region: string; track: string; count: number }>();
    const missing: Record<string, number> = {};
    const sample: string[] = [];
    let unclassified = 0;
    for (const record of stores) {
      const region = segmentRegion(record.data.jurisdiction, ruleset.data);
      if (!region || !record.data.track) {
        unclassified++;
        const key = !region ? 'region' : 'track';
        missing[key] = (missing[key] ?? 0) + 1;
        if (sample.length < 20) sample.push(record.id);
      } else {
        const key = `${region}|${record.data.track}`;
        const group = groups.get(key) ?? { region, track: record.data.track, count: 0 };
        group.count++;
        groups.set(key, group);
      }
    }
    if (counts && counts.reduce((sum, row) => sum + row.n, 0) === stores.length) {
      const folded = new Map<string, number>();
      for (const row of counts) {
        const [j, t] = row.key;
        if (typeof j !== 'string' || typeof t !== 'string') continue;
        const r = segmentRegion(j, ruleset.data);
        if (r) folded.set(`${r}|${t}`, (folded.get(`${r}|${t}`) ?? 0) + row.n);
      }
      // 并发快照不一致时仍以刚完成的逐页记录为准。
      if ([...groups].every(([key, group]) => folded.get(key) === group.count))
        for (const [key, group] of groups) group.count = folded.get(key)!;
    }
    const verifications: Verification[] = [];
    for (const store of stores) {
      const derived = [...new Set(ruleset.data.trackSupply[store.data.track] ?? [])].sort();
      if (
        store.data.supplyCategories &&
        canonicalJson([...new Set(store.data.supplyCategories)].sort()) !== canonicalJson(derived)
      )
        verifications.push({
          asset: assetRef(store),
          purpose: 'replenishment/classifyStores',
          verdict: 'fails',
          dimension: 'supplyCategories',
          reason: 'Stored supply categories differ from the track ruleset',
          measured: {
            field: 'supplyCategories',
            expected: derived.join(','),
            actual: [...store.data.supplyCategories].sort().join(','),
          },
          at: ctx.now,
          by: ctx.actor,
        });
    }
    return result(
      {
        total: stores.length,
        segments: [...groups.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, group]) => ({
            key,
            ...group,
            supplyCats: [...new Set(ruleset.data.trackSupply[group.track] ?? [])].sort(),
            filter: segmentFilter(group.region, group.track, ruleset.data),
          })),
        unclassified: { count: unclassified, byMissing: missing, sample },
      },
      [],
      verifications,
    );
  },
};
