import { defineSlot, z } from '@osw/core';
export const CourseUnit = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  station: z.string(),
  positions: z.array(z.string()),
  critical: z.boolean(),
  controls: z.array(z.string()),
  covers: z.array(z.string()),
});
export const Course = z.object({
  key: z.string().min(1),
  rights: z.string().min(1),
  version: z.string().min(1),
  sourceDocs: z.array(z.string()),
  units: z.array(CourseUnit),
});
export const CourseSlot = defineSlot({
  name: 'course',
  schema: Course,
  filterable: { key: ['eq', 'in'], 'units[].covers': ['hasAny'], 'units[].positions': ['hasAny'] },
  sortable: ['key'],
  validate: (value) => {
    if (new Set(value.units.map((u) => u.id)).size !== value.units.length)
      throw new Error('Course unit ids must be unique');
  },
});
