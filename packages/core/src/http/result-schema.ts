import { z } from '../base.js';
export const RecordResultSchema = z.object({
  status: z.enum([
    'recorded',
    'duplicate',
    'source_changed',
    'not_found',
    'not_empty',
    'rejected',
    'unsupported',
  ]),
  detail: z.string().optional(),
});
