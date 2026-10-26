import { z } from '@osw/core';
export const CertPlanContent = z.object({
  standard: z.string().min(1),
  groups: z.array(z.string()),
  excludeKeys: z.array(z.string()),
  checks: z.record(z.string(), z.array(z.string().min(1).max(80)).max(20)).default({}),
});
