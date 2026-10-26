import { defineSlot, z } from '@osw/core';

export const ContentPlaybook = z.object({
  weeks: z.array(
    z.object({
      weekOffset: z.number().int(),
      count: z.number().int().nonnegative(),
      mix: z.record(z.string().min(1), z.number().min(0).max(1)),
    }),
  ),
  scripts: z.record(z.string().min(1), z.array(z.string())),
});
export const contentPlaybookSlot = defineSlot({
  name: 'content-playbook',
  schema: ContentPlaybook,
  validate: (value) => {
    for (const week of value.weeks) {
      const total = Object.values(week.mix).reduce((sum, share) => sum + share, 0);
      if (week.count > 0 && Math.abs(total - 1) > Number.EPSILON * Object.keys(week.mix).length)
        throw new Error('Content mix must sum to one');
      if (Object.keys(week.mix).some((goal) => !Object.hasOwn(value.scripts, goal)))
        throw new Error('Each content goal requires a script');
    }
  },
});
