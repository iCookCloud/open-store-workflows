import { type AssetRecordOf, isWithin, type z } from '@osw/core';
import type { ComplianceItem } from '../slots.js';

export type ItemRecord = AssetRecordOf<z.infer<typeof ComplianceItem>>;
export interface EffectiveItem {
  rootId: string;
  lineage: string[];
  record: ItemRecord;
  retired: boolean;
}
export function mergeChain(levels: ItemRecord[][], jurisdiction: string) {
  const effective: EffectiveItem[] = [];
  const orphans: string[] = [];
  for (const items of levels) {
    // 同层改写只允许指向进入本层以前的 lineage；重复改写全部拒收。
    const ancestors = new Map(
      effective.flatMap((item) => item.lineage.map((id) => [id, item] as const)),
    );
    const applicable = items.filter(
      (item) => !item.data.jurisdiction || isWithin(jurisdiction, item.data.jurisdiction),
    );
    const overrides = new Map<EffectiveItem, ItemRecord[]>();
    for (const item of applicable) {
      if (item.data.overrideOf === null) {
        effective.push({
          rootId: item.id,
          lineage: [item.id],
          record: item,
          retired: item.data.retired,
        });
        continue;
      }
      const target = ancestors.get(item.data.overrideOf);
      if (!target) {
        orphans.push(item.id);
        continue;
      }
      const group = overrides.get(target) ?? [];
      group.push(item);
      overrides.set(target, group);
    }
    for (const [target, changes] of overrides) {
      if (changes.length !== 1) {
        orphans.push(...changes.map((item) => item.id));
        continue;
      }
      const item = changes[0];
      target.lineage.push(item.id);
      target.record = item;
      target.retired = item.data.retired;
    }
  }
  return { items: effective.filter((item) => !item.retired), orphans: orphans.sort() };
}
