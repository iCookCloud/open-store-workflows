import type { z } from '@osw/core';
import type { AssetPlanContent } from '../templates/asset-plan.js';
import type { AssetProgress, Marketing } from './models.js';

export function deriveAssetGap(
  template: AssetPlanContent,
  progress: z.infer<typeof AssetProgress>[],
): z.infer<typeof Marketing>['assetGap'] {
  const states = new Map(progress.map((item) => [item.key, item]));
  let required = 0;
  let ready = 0;
  const blocked = new Set<string>();
  for (const item of template.items) {
    const state = states.get(item.key);
    if (state?.status === 'skipped') continue;
    const actual = Math.min(item.required, state?.ready ?? 0);
    required += item.required;
    ready += actual;
    if (actual < item.required) for (const channel of item.channels) blocked.add(channel);
  }
  return { required, ready, missing: required - ready, blockedChannels: [...blocked].sort() };
}
