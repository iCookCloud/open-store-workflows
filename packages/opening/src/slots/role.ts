import { LocalizedText, defineSlot, z } from '@osw/core';
export const Role = z.object({
  key: z.string().min(1),
  standard: z.string().min(1),
  onboardWave: z.string(),
  stationKey: z.string().min(1).optional(),
  relief: z.boolean(),
  names: LocalizedText,
});
export const RoleSlot = defineSlot({
  name: 'role',
  schema: Role,
  filterable: {
    key: ['eq', 'in'],
    standard: ['eq', 'in'],
    stationKey: ['eq', 'in'],
    relief: ['eq'],
  },
  sortable: ['key', 'onboardWave'],
});
