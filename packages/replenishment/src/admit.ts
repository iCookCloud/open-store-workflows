import {
  ArtifactEnvelope,
  BomBody,
  type Need,
  OpeningRecordBody,
  ProductSlot,
  type StepDef,
  StoreSlot,
  getMany,
  versionHash,
  z,
} from '@osw/core';
import { result } from './helpers.js';
import { ReorderLine, lineKey } from './models-reorder.js';

const Input = z.object({
  opening: ArtifactEnvelope('OpeningRecord', OpeningRecordBody),
  bom: ArtifactEnvelope('Bom', BomBody),
});
export const AdmitOutput = z.object({
  storeId: z.string(),
  openedAt: z.string(),
  menuRef: OpeningRecordBody.shape.menuRef,
  bomRef: OpeningRecordBody.shape.bomRef,
  seedLines: z.array(ReorderLine),
  skipped: z.array(z.string()),
});
export const admitFromOpening: StepDef<typeof Input, typeof AdmitOutput> = {
  id: 'replenishment/admitFromOpening',
  input: Input,
  output: AdmitOutput,
  reads: ['store', 'product'],
  params: [],
  async run(input, ctx) {
    const { opening, bom } = input;
    const needs: Need[] = [];
    for (const artifact of [opening, bom])
      if (artifact.hash !== (await versionHash(artifact.body)))
        needs.push({
          kind: 'input',
          path: artifact.kind === 'Bom' ? 'bom.hash' : 'opening.hash',
          reason: 'Artifact content does not match its envelope hash',
          blocking: true,
        });
    const storeId = opening.storeId;
    if (!storeId || !opening.body.handoff || !opening.body.decidedAt)
      return result(
        {
          storeId: storeId ?? '',
          openedAt: '',
          menuRef: opening.body.menuRef,
          bomRef: opening.body.bomRef,
          seedLines: [],
          skipped: [],
        },
        [
          {
            kind: 'input',
            path: 'opening',
            reason: 'Opening must contain an admitted handoff and decision time',
            blocking: true,
          },
        ],
      );
    if (
      bom.storeId !== storeId ||
      opening.body.bomRef.kind !== 'Bom' ||
      opening.body.bomRef.id !== bom.id ||
      opening.body.bomRef.hash !== bom.hash
    )
      needs.push({
        kind: 'input',
        path: 'bom',
        reason: 'Opening must reference this store BOM version',
        blocking: true,
      });
    if (Date.parse(opening.body.decidedAt) > Date.parse(ctx.now))
      needs.push({
        kind: 'input',
        path: 'opening.body.decidedAt',
        reason: 'Opening decision cannot be in the future',
        blocking: true,
      });
    const store = await ctx.assets.get(StoreSlot, storeId);
    if (!store)
      needs.push({
        kind: 'asset',
        slot: 'store',
        filter: { field: 'id', op: 'eq', value: storeId },
        reason: 'Opening store is missing',
        blocking: true,
      });
    else if (store.data.status === 'preparing')
      needs.push({
        kind: 'action',
        action: 'admitStore',
        ref: storeId,
        reason: 'Asset owner must admit the released store to operating',
        blocking: true,
      });
    else if (store.data.status !== 'operating')
      needs.push({
        kind: 'input',
        path: 'store.status',
        reason: 'Closed stores cannot start replenishment',
        blocking: true,
      });
    const seedLines: ReorderLine[] = [];
    const skipped: string[] = [];
    const products = await getMany(ctx.assets, ProductSlot, [
      ...new Set(
        bom.body.lines
          .filter((line) => line.lineKind === 'food' || line.lineKind === 'supplies')
          .flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
      ),
    ]);
    const byId = new Map(products.map((product) => [product.id, product]));
    for (const line of bom.body.lines) {
      if (line.lineKind !== 'food' && line.lineKind !== 'supplies') continue;
      if (line.offerRef && line.offerRef.slot !== 'offer') {
        needs.push({
          kind: 'input',
          path: `bom.lines.${line.id}.offerRef`,
          reason: 'Initial price must reference the offer slot',
          blocking: true,
        });
        continue;
      }
      const product = line.productRef ? byId.get(line.productRef.id) : undefined;
      if (
        line.productRef &&
        (!product ||
          line.productRef.slot !== 'product' ||
          product.redacted?.length ||
          (product.versionHash !== line.productRef.versionHash &&
            product.fieldsetHashes?.[line.productRef.fieldset ?? ''] !==
              line.productRef.versionHash))
      ) {
        needs.push({
          kind: 'asset',
          slot: 'product',
          filter: { field: 'id', op: 'eq', value: line.productRef.id },
          reason: 'BOM product version is missing, changed, or redacted',
          blocking: true,
        });
        continue;
      }
      if (product?.coverage.frequency === 'opening' || line.qty <= 0) {
        skipped.push(line.name);
        continue;
      }
      const value: ReorderLine = {
        id: line.id,
        lineKind: line.lineKind,
        qty: line.qty,
        unit: line.unit,
        name: line.name,
        spec: line.spec,
        key: '',
        weakKey: !line.productRef,
        priceSource: line.unitPrice.basis === 'invoice' ? 'last-paid' : 'unpriced',
        ...(line.unitPrice.basis === 'invoice'
          ? { unitPrice: { amount: line.unitPrice.amount, currency: line.unitPrice.currency } }
          : {}),
        ...(line.productRef ? { productRef: line.productRef } : {}),
        ...(line.offerRef ? { offerRef: line.offerRef, initialOfferRef: line.offerRef } : {}),
        ...(line.coverDays ? { coverDays: line.coverDays } : {}),
      };
      value.key = lineKey(value);
      seedLines.push(value);
    }
    return result(
      {
        storeId,
        openedAt: opening.body.decidedAt,
        menuRef: opening.body.menuRef,
        bomRef: opening.body.bomRef,
        seedLines,
        skipped,
      },
      needs,
    );
  },
};
