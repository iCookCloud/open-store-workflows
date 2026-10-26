import {
  type AssetRecordOf,
  type Filter,
  type Need,
  type Product,
  ProductSlot,
  type StepCtx,
  type StepDef,
  assetRef,
  getMany,
  z,
} from '@osw/core';
import { addSources, approval, assertVersion, inputNeed, queryAll, result } from '../helpers.js';
import { BomDraft } from '../schema.js';
export const ResolveInput = z.object({ draft: BomDraft });
export const normalizeName = (name: string) =>
  name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export async function resolveProducts(raw: z.infer<typeof ResolveInput>, ctx: StepCtx) {
  const { draft } = ResolveInput.parse(raw);
  const needs: Need[] = [];
  const existing = await getMany(
    ctx.assets,
    ProductSlot,
    draft.lines.flatMap((l) => (l.productRef ? [l.productRef.id] : [])),
  );
  const pool = new Map<string, AssetRecordOf<Product>>(existing.map((p) => [p.id, p]));
  const unresolved = draft.lines.filter((l) => !l.productRef);
  for (let offset = 0; offset < unresolved.length; offset += 31) {
    const batch = unresolved.slice(offset, offset + 31);
    const filters: Filter[] = [];
    for (const line of batch) {
      // DSL 的 contains 至少三个字符；短品名只能以已知品类缩小查询。
      if (normalizeName(line.name).length >= 3)
        filters.push({ field: 'name', op: 'contains', value: line.name.normalize('NFKC').trim() });
      else if (line.category) filters.push({ field: 'category', op: 'eq', value: line.category });
      else
        needs.push(
          inputNeed(
            `lines.${line.id}.category`,
            'Short names require a category to bound product search',
          ),
        );
    }
    if (filters.length)
      for (const p of await queryAll(ctx, ProductSlot, {
        all: [{ field: 'status', op: 'eq', value: 'active' }, { any: filters }],
      }))
        pool.set(p.id, p);
  }
  const fallbackCategories = [
    ...new Set(
      unresolved
        .filter(
          (l) =>
            ![...pool.values()].some((p) =>
              Object.values(p.data.name).some((n) => normalizeName(n) === normalizeName(l.name)),
            ),
        )
        .map((l) => l.category)
        .filter(Boolean),
    ),
  ];
  for (let offset = 0; offset < fallbackCategories.length; offset += 200) {
    for (const p of await queryAll(ctx, ProductSlot, {
      all: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'category', op: 'in', value: fallbackCategories.slice(offset, offset + 200) },
      ],
    }))
      pool.set(p.id, p);
  }
  for (const line of draft.lines) {
    if (line.productRef) {
      const p = pool.get(line.productRef.id);
      if (assertVersion(p, line.productRef, needs) && p?.data.status !== 'active')
        needs.push(inputNeed(`lines.${line.id}.productRef`, 'Product is discontinued'));
      continue;
    }
    const candidates = [...pool.values()]
      .filter(
        (p) =>
          p.data.status === 'active' &&
          Object.values(p.data.name).some(
            (name) => normalizeName(name) === normalizeName(line.name),
          ),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let selected: AssetRecordOf<Product> | undefined;
    if (candidates.length === 1) selected = candidates[0];
    else if (candidates.length > 1) {
      const gate = await approval(
        ctx,
        'resolveProducts',
        `line:${line.id}`,
        { line, candidates: candidates.map((p) => ({ ref: assetRef(p), data: p.data })) },
        `为 ${line.name} 选择同名产品`,
        candidates.map((p) => p.id),
      );
      if (!gate.accepted) needs.push(gate.need);
      else selected = candidates.find((p) => p.id === gate.accepted?.decision);
    } else
      needs.push({
        kind: 'action',
        action: line.pricingMode === 'custom' ? 'createProduct' : 'findProduct',
        ref: `line:${line.id}`,
        reason: 'No unique active product; create or supply its reference',
        blocking: true,
      });
    if (selected) {
      line.productRef = assetRef(selected);
      line.category = selected.data.category;
      line.volumePerUnit = selected.data.unitVolumeM3;
      addSources(draft, [assetRef(selected)]);
    }
  }
  addSources(
    draft,
    existing.map((p) => assetRef(p)),
  );
  return result(draft, needs);
}
export const resolveProductsStep = {
  id: 'fitout-bom/resolveProducts',
  input: ResolveInput,
  output: BomDraft,
  reads: ['product'],
  params: [],
  approval: { question: '选择同名产品', decision: z.string() },
  run: resolveProducts,
} satisfies StepDef<typeof ResolveInput, typeof BomDraft>;
