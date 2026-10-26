import { Requirement, type SlotDef, defineSlot, validateRequirement, z } from '@osw/core';

export const ProfileRequirement = Requirement.extend({ reason: z.string().min(1) });
export const SiteProfile = z
  .object({
    storeType: z.string().min(1),
    requirements: z.array(ProfileRequirement),
    equipmentTriggers: z.array(
      z.object({ termKeys: z.array(z.string().min(1)).min(1), requirement: ProfileRequirement }),
    ),
  })
  .superRefine((value, ctx) => {
    const validate = (
      requirement: z.infer<typeof ProfileRequirement>,
      path: (string | number)[],
    ) => {
      try {
        validateRequirement(requirement);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: error instanceof Error ? error.message : 'Invalid requirement',
        });
      }
    };
    value.requirements.forEach((requirement, index) =>
      validate(requirement, ['requirements', index]),
    );
    value.equipmentTriggers.forEach((trigger, index) =>
      validate(trigger.requirement, ['equipmentTriggers', index, 'requirement']),
    );
  });
export type SiteProfile = z.infer<typeof SiteProfile>;
export const siteProfileSlot: SlotDef<typeof SiteProfile> = defineSlot({
  name: 'site-profile',
  slotVersion: '0.1.0',
  schema: SiteProfile,
  filterable: { storeType: ['eq', 'in'] },
  sortable: ['storeType'],
});
export const SiteProfileSlot = siteProfileSlot;
