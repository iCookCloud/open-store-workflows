import { z } from '@osw/core';

export const AssetPlanContent = z
  .object({
    items: z.array(
      z.object({
        key: z.string().min(1),
        required: z.number().int().nonnegative(),
        channels: z.array(z.string().min(1)),
      }),
    ),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.key)).size !== value.items.length)
      ctx.addIssue({ code: 'custom', message: 'Asset keys must be unique', path: ['items'] });
  });
export type AssetPlanContent = z.infer<typeof AssetPlanContent>;
