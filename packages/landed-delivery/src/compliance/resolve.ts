import { type AssetRecordOf, type StepCtx, getMany, type z } from '@osw/core';
import { queryIn } from '../helpers.js';
import type { ComplianceEntry } from '../models.js';
import { type ComplianceCategory, complianceCategorySlot, complianceItemSlot } from '../slots.js';
import { mergeChain } from './merge-chain.js';

export async function resolveCategories(
  categoryIds: string[],
  market: string,
  jurisdiction: string,
  ctx: StepCtx,
) {
  const categories = new Map<string, AssetRecordOf<z.infer<typeof ComplianceCategory>>>();
  const fetched = new Set<string>();
  let frontier = [...new Set(categoryIds)];
  // 额外读一层用于区分深度越界与缺失父节点；查询次数只依赖深度和批大小。
  for (let depth = 0; depth < 7 && frontier.length; depth++) {
    const ids = frontier.filter((id) => !fetched.has(id));
    for (const id of ids) fetched.add(id);
    const records = await getMany(ctx.assets, complianceCategorySlot, ids);
    for (const record of records) categories.set(record.id, record);
    frontier = records.flatMap((record) => (record.data.parentId ? [record.data.parentId] : []));
  }
  const items = await queryIn(ctx.assets, complianceItemSlot, 'categoryId', [...categories.keys()]);
  return new Map(
    [...new Set(categoryIds)].map((categoryId) => {
      const chain: string[] = [];
      let id: string | null = categoryId;
      let tree: ComplianceEntry['tree'] = 'ok';
      while (id) {
        if (chain.includes(id)) {
          tree = 'cycle';
          break;
        }
        const category = categories.get(id);
        if (!category || category.data.goneAt !== null) {
          tree = chain.length ? 'missing_parent' : 'missing_category';
          break;
        }
        if (category.data.market !== market) {
          tree = 'cross_market';
          break;
        }
        if (chain.length >= 6) {
          tree = 'too_deep';
          break;
        }
        chain.push(id);
        id = category.data.parentId;
      }
      chain.reverse();
      const levels = chain.map((parent) => items.filter((item) => item.data.categoryId === parent));
      if (tree === 'ok' && levels.flat().some((item) => item.data.market !== market))
        tree = 'item_market_mismatch';
      const merged = tree === 'ok' ? mergeChain(levels, jurisdiction) : { items: [], orphans: [] };
      return [
        categoryId,
        {
          tree,
          ...merged,
          sources: chain.map((key) => categories.get(key)!).filter(Boolean),
          itemSources: levels.flat(),
        },
      ] as const;
    }),
  );
}
