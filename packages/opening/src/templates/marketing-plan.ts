import { Jurisdiction, z } from '@osw/core';

const Qualifier = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'Parameter qualifiers must use letters and digits');

export const MarketingPlanContent = z
  .object({
    items: z.array(
      z.object({
        key: z.string().min(1),
        channel: Qualifier,
        title: z.string().min(1),
        dayOffset: z.number().int(),
        deliverable: z.string(),
        core: z.boolean(),
        category: z.string().min(1),
        stage: Qualifier,
      }),
    ),
    creatorSelection: z
      .object({
        tiers: z.array(Qualifier).min(1),
        formats: z.array(z.string().min(1)).min(1),
        audienceLanguages: z.array(z.string().min(1)).min(1),
        mixRoles: z.array(Qualifier).min(1),
      })
      .optional(),
    reviewPolicy: z.object({ buyReviews: z.boolean(), solicitReviews: z.boolean() }).optional(),
    disclosureRules: z.array(z.object({ jurisdiction: Jurisdiction, required: z.boolean() })),
  })
  .superRefine((value, ctx) => {
    if (value.reviewPolicy?.buyReviews || value.reviewPolicy?.solicitReviews)
      ctx.addIssue({
        code: 'custom',
        message: 'Marketing may not buy or solicit reviews',
        path: ['reviewPolicy'],
      });
    if (new Set(value.items.map((item) => item.key)).size !== value.items.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Marketing item keys must be unique',
        path: ['items'],
      });
    const selection = value.creatorSelection;
    if (
      selection &&
      [selection.tiers, selection.formats, selection.audienceLanguages, selection.mixRoles].some(
        (values) => new Set(values).size !== values.length,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Creator selection lists must be unique',
        path: ['creatorSelection'],
      });
  });
export type MarketingPlanContent = z.infer<typeof MarketingPlanContent>;
