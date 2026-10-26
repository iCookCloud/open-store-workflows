import type { FilterOp, SlotDef } from '@osw/core';
import { BomCase, Design, LineTemplate, MaterialRate } from '../schema.js';
const shared = {
  id: ['eq', 'in'],
  'coverage.tracks': ['hasAny'],
  'coverage.jurisdictions': ['hasAny'],
} satisfies Record<string, FilterOp[]>;
export const designSlot = {
  name: 'design',
  slotVersion: '0.1.0',
  schema: Design,
  filterable: { ...shared, kind: ['eq', 'in'] },
  sortable: ['updatedAt'],
} satisfies SlotDef<typeof Design>;
export const materialRateSlot = {
  name: 'material-rate',
  slotVersion: '0.1.0',
  schema: MaterialRate,
  filterable: { ...shared, kind: ['eq', 'in'], group: ['eq', 'in'] },
  sortable: ['updatedAt'],
} satisfies SlotDef<typeof MaterialRate>;
export const lineTemplateSlot = {
  name: 'line-template',
  slotVersion: '0.1.0',
  schema: LineTemplate,
  filterable: { ...shared, shape: ['eq', 'in'], lineKind: ['eq', 'in'] },
  sortable: ['updatedAt'],
} satisfies SlotDef<typeof LineTemplate>;
export const bomCaseSlot = {
  name: 'bom-case',
  slotVersion: '0.1.0',
  schema: BomCase,
  filterable: shared,
  sortable: ['updatedAt'],
} satisfies SlotDef<typeof BomCase>;
export const slots = [designSlot, materialRateSlot, lineTemplateSlot, bomCaseSlot];
