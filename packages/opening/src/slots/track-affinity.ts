import { TrackKey, defineSlot, z } from '@osw/core';
export const TrackAffinity = z.object({ track: TrackKey, borrowFrom: z.array(TrackKey) });
// 槽位名遵循 core 的小写连字符约束，数据字段仍使用 camelCase。
export const TrackAffinitySlot = defineSlot({
  name: 'track-affinity',
  schema: TrackAffinity,
  filterable: { track: ['eq', 'in'] },
  sortable: ['track'],
});
