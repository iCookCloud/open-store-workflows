import { AssetId, IsoDate, IsoDateTime, Jurisdiction, Money, defineSlot, z } from '@osw/core';

const eqin = ['eq', 'in'] as const;
export const ComplianceCategory = z.object({
  parentId: AssetId.nullable(),
  market: Jurisdiction,
  name: z.string().min(1),
  goneAt: IsoDateTime.nullable(),
});
export const ComplianceItem = z.object({
  categoryId: AssetId,
  market: Jurisdiction,
  jurisdiction: Jurisdiction.optional(),
  name: z.string().min(1),
  level: z.enum(['entity', 'batch', 'sku']),
  entityRole: z.enum(['supplier', 'importer']).nullable(),
  required: z.enum(['mandatory', 'advisory']),
  issuer: z.string(),
  officialUrl: z.url().nullable(),
  evidenceHint: z.string(),
  certTag: z.string().nullable(),
  overrideOf: AssetId.nullable(),
  retired: z.boolean(),
});
export const ProductClassification = z.object({
  productId: AssetId,
  market: Jurisdiction,
  categoryId: AssetId,
  by: z.string().min(1),
  at: IsoDateTime,
});
export const ComplianceAnswer = z.object({
  market: Jurisdiction,
  itemRootId: AssetId,
  subject: z.object({ kind: z.enum(['party', 'product']), id: AssetId }),
  state: z.enum(['cited', 'not_in_materials', 'pending_review']),
  evidence: z.array(z.string()),
  validUntil: IsoDate.nullable(),
  by: z.string().min(1),
  at: IsoDateTime,
});
export const RateCard = z.object({
  partyId: AssetId,
  from: Jurisdiction,
  to: Jurisdiction,
  mode: z.enum(['sea_fcl', 'sea_lcl', 'air', 'ground']),
  goodsClass: z.enum(['food', 'nonfood']),
  basis: z.enum(['shipment', 'm3', 'kg', 'carton']),
  rate: Money,
  validFrom: IsoDate,
  validTo: IsoDate,
});
export const PackingHistory = z.object({
  productId: AssetId,
  hsCode: z
    .string()
    .regex(/^\d{6,10}$/)
    .nullable(),
  materialText: z.string().nullable(),
  confirmedAt: IsoDateTime,
});
// 槽位名沿用 core 的 kebab-case 协议；业务 schema 使用英文实体名。
export const complianceCategorySlot = defineSlot({
  name: 'compliance-category',
  schema: ComplianceCategory,
  filterable: { market: eqin, parentId: eqin },
});
export const complianceItemSlot = defineSlot({
  name: 'compliance-item',
  schema: ComplianceItem,
  filterable: { categoryId: eqin, market: eqin },
});
export const productClassificationSlot = defineSlot({
  name: 'product-classification',
  schema: ProductClassification,
  filterable: { productId: eqin, market: eqin },
});
export const complianceAnswerSlot = defineSlot({
  name: 'compliance-answer',
  schema: ComplianceAnswer,
  filterable: { itemRootId: eqin, 'subject.id': eqin, market: eqin },
  sortable: ['at'],
});
export const rateCardSlot = defineSlot({
  name: 'rate-card',
  schema: RateCard,
  filterable: { partyId: eqin, from: eqin, to: eqin, mode: eqin, goodsClass: eqin },
  validate(data) {
    if (data.validFrom > data.validTo || data.rate.amount < 0)
      throw new Error('Invalid rate card validity or amount');
  },
});
export const packingHistorySlot = defineSlot({
  name: 'packing-history',
  schema: PackingHistory,
  filterable: { productId: eqin },
  sortable: ['confirmedAt'],
});
export const slots = [
  complianceCategorySlot,
  complianceItemSlot,
  productClassificationSlot,
  complianceAnswerSlot,
  rateCardSlot,
  packingHistorySlot,
];
