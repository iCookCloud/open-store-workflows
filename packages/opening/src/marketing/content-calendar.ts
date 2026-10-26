import { type AssetRecordOf, addDays, assetRef, type z } from '@osw/core';
import type { ContentPlaybook } from '../slots/content-playbook.js';

export function contentCalendar(
  openingDate: string,
  playbooks: AssetRecordOf<z.infer<typeof ContentPlaybook>>[],
) {
  const daysPerWeek = 7;
  return playbooks.flatMap((record) =>
    record.data.weeks.flatMap((week, weekIndex) => {
      const allocation = Object.entries(week.mix)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([goal, share]) => ({
          goal,
          n: Math.floor(week.count * share),
          remainder: (week.count * share) % 1,
        }));
      let remainder = week.count - allocation.reduce((sum, entry) => sum + entry.n, 0);
      const ranking = [...allocation].sort(
        (a, b) => b.remainder - a.remainder || (a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0),
      );
      for (const entry of ranking)
        if (remainder > 0) {
          entry.n++;
          remainder--;
        }
      let index = 0;
      return allocation.flatMap(({ goal, n }) =>
        Array.from({ length: n }, () => {
          const current = index++;
          return {
            key: `${record.id}:${weekIndex}:${current}`,
            goal,
            date: addDays(
              openingDate,
              week.weekOffset * daysPerWeek + Math.floor((current * daysPerWeek) / week.count),
            ),
            beats: record.data.scripts[goal],
            source: assetRef(record),
          };
        }),
      );
    }),
  );
}
