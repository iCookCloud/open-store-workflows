import {
  type BomLine,
  MenuSlot,
  type Need,
  ProductSlot,
  RecipeSlot,
  type StepCtx,
  type StepDef,
  assetRef,
  convertUnit,
  getMany,
  versionHash,
  z,
} from '@osw/core';
import { addSources, assertVersion, inputNeed, numberParam, queryAll, result } from '../helpers.js';
import { BomDraft, MenuPlan } from '../schema.js';
import { lineTemplateSlot } from '../slots/index.js';
import { StoreSpec } from './scale-to-site.js';
export const DeriveInput = z.object({
  draft: BomDraft,
  store: StoreSpec,
  menuPlans: z.array(MenuPlan).optional(),
  servingsPerDay: z.record(z.string(), z.number().nonnegative()).optional(),
  foodTemplateId: z.string().optional(),
  equipmentTemplateId: z.string().optional(),
});
export async function deriveMenuLines(raw: z.infer<typeof DeriveInput>, ctx: StepCtx) {
  const input = DeriveInput.parse(raw);
  const { draft, store } = input;
  const needs: Need[] = [];
  if (store.body.concept.nonFood) return result(draft);
  const menus = await getMany(
    ctx.assets,
    MenuSlot,
    store.body.menu.approved.map((r) => r.id),
  );
  if (!menus.length)
    return result(draft, [
      inputNeed('store.menu.approved', 'A food store requires an approved structured menu'),
    ]);
  const plans = input.menuPlans ?? [];
  for (const ref of store.body.menu.approved)
    assertVersion(
      menus.find((m) => m.id === ref.id),
      ref,
      needs,
    );
  const recipeIds = menus.flatMap(
    (m) => m.data.items?.flatMap((i) => (i.recipeId ? [i.recipeId] : [])) ?? [],
  );
  const recipes = await getMany(ctx.assets, RecipeSlot, recipeIds);
  const templates = await getMany(
    ctx.assets,
    lineTemplateSlot,
    [input.foodTemplateId, input.equipmentTemplateId].filter((id): id is string => !!id),
  );
  const foodTemplate = templates.find((t) => t.id === input.foodTemplateId);
  const equipmentTemplate = templates.find((t) => t.id === input.equipmentTemplateId);
  const quantities = new Map<
    string,
    {
      productId?: string;
      termKey?: string;
      qty: number;
      unit: BomLine['unit'];
      recipeId: string;
      ingredientIndex: number;
      coverDays: number;
    }
  >();
  const equipmentKeys = new Set<string>();
  for (const menu of menus) {
    if (!menu.data.items) {
      needs.push(inputNeed(`menus.${menu.id}.items`, 'Menu items have not been structured'));
      continue;
    }
    for (const e of menu.data.derives?.equipment ?? []) equipmentKeys.add(e.key);
    const plan = plans.find((p) => p.menuRef.id === menu.id);
    if (plan && !assertVersion(menu, plan.menuRef, needs)) continue;
    const coverDays = plan?.coverDays ?? numberParam(ctx, 'food.openingCoverDays', needs);
    if (coverDays === null || coverDays <= 0) {
      if (coverDays !== null)
        needs.push(inputNeed('food.openingCoverDays', 'Expected positive cover days'));
      continue;
    }
    for (const item of menu.data.items) {
      const recipe = recipes.find((r) => r.id === item.recipeId);
      if (!recipe) {
        needs.push(inputNeed(`menus.${menu.id}.${item.id}.recipeId`, 'Recipe is required'));
        continue;
      }
      const itemPlan = plan?.items.find((i) => i.menuItemId === item.id);
      if (itemPlan && !assertVersion(recipe, itemPlan.recipeRef, needs)) continue;
      const servings = itemPlan?.servingsPerDay ?? input.servingsPerDay?.[item.id];
      if (servings === undefined) {
        needs.push(inputNeed(`servingsPerDay.${item.id}`, 'Daily servings are required'));
        continue;
      }
      if (recipe.data.yield.value <= 0 || !['pcs', 'set'].includes(recipe.data.yield.unit)) {
        needs.push(
          inputNeed(
            `recipes.${recipe.id}.yield`,
            'Recipe yield must be a positive portion count in pcs or set',
          ),
        );
        continue;
      }
      for (const [index, ingredient] of recipe.data.ingredients.entries()) {
        const key = ingredient.productId
          ? `product:${ingredient.productId}`
          : `term:${ingredient.termKey}`;
        const qty = (servings * coverDays * ingredient.qty) / recipe.data.yield.value;
        const existing = quantities.get(key);
        if (existing) {
          const conversion = convertUnit(qty, ingredient.unit, existing.unit);
          if (conversion.value === null)
            needs.push(
              inputNeed(
                `recipes.${recipe.id}.ingredients.${index}`,
                'Ingredient units are incompatible',
              ),
            );
          else existing.qty += conversion.value;
          existing.coverDays = Math.max(existing.coverDays, coverDays);
        } else
          quantities.set(key, {
            productId: ingredient.productId,
            termKey: ingredient.termKey,
            qty,
            unit: ingredient.unit,
            recipeId: recipe.id,
            ingredientIndex: index,
            coverDays,
          });
      }
    }
  }
  const products = await getMany(
    ctx.assets,
    ProductSlot,
    [...quantities.values()].flatMap((i) => (i.productId ? [i.productId] : [])),
  );
  const templateIds = [...equipmentKeys];
  const equipment = [];
  for (let i = 0; i < templateIds.length; i += 200)
    equipment.push(
      ...(await queryAll(ctx, ProductSlot, {
        all: [
          { field: 'category', op: 'in', value: templateIds.slice(i, i + 200) },
          { field: 'status', op: 'eq', value: 'active' },
        ],
      })),
    );
  const base = (
    id: string,
    name: string,
    kind: 'food' | 'equipment',
    category: string,
    budgetKey: BomLine['budgetKey'],
    qty: number,
    unit: BomLine['unit'],
  ): BomLine => ({
    id,
    name,
    lineKind: kind,
    category,
    budgetKey,
    qty,
    unit,
    zone: kind === 'food' ? 'Opening inventory' : 'Kitchen',
    spec: '',
    qtyRule: { kind: 'manual' },
    qtyBasis: {
      status: 'derived',
      note:
        kind === 'food'
          ? 'Gross recipe quantity × daily portions × cover days'
          : 'One per equipment category; capacity requires human review',
    },
    dimsBasis: { status: 'estimated', note: 'Dimensions require product confirmation' },
    evidence: [],
    derivedFrom: { kind: 'menu', ref: menus.map((m) => m.id).join(',') },
    pricingMode: 'whole',
    components: [],
    modelCostPerUnit: null,
    parts: [],
    modelWarnings: [],
    sourcing: null,
    costBasis: 'model',
    unitPrice: { amount: 0, currency: draft.currency, basis: 'estimate' },
  });
  const derived: BomLine[] = [];
  if (quantities.size && !foodTemplate)
    needs.push(inputNeed('foodTemplateId', 'Food line template is required'));
  else
    for (const [key, q] of quantities) {
      const product = products.find((p) => p.id === q.productId);
      if (q.productId && (!product || product.data.status !== 'active')) {
        needs.push(inputNeed(key, 'Active ingredient product not found'));
        continue;
      }
      // carton.units 是件数，不可拿它对 kg/L 的数量取整。
      const pack = product?.data.carton?.units;
      if (pack && !['pcs', 'pack', 'set'].includes(q.unit)) {
        needs.push(
          inputNeed(
            key,
            'Carton units require a per-piece mass or volume mapping before packaging',
          ),
        );
        continue;
      }
      const qty = pack ? Math.ceil(q.qty / pack - 1e-10) * pack : q.qty;
      const id = `menu-${(await versionHash(key)).slice(0, 20)}`;
      const line = base(
        id,
        product ? Object.values(product.data.name)[0] : q.termKey!,
        'food',
        product?.data.category ?? q.termKey!,
        foodTemplate!.data.budgetKey,
        qty,
        q.unit,
      );
      line.productRef = product ? assetRef(product) : undefined;
      line.qtyRule = { kind: 'menu', recipeId: q.recipeId, ingredientIndex: q.ingredientIndex };
      line.coverDays = q.coverDays;
      derived.push(line);
    }
  if (equipmentKeys.size && !equipmentTemplate)
    needs.push(inputNeed('equipmentTemplateId', 'Equipment line template is required'));
  else
    for (const key of equipmentKeys) {
      const matches = equipment.filter((p) => p.data.category === key);
      const p = matches.length === 1 ? matches[0] : undefined;
      const id = `menu-${(await versionHash({ equipment: key })).slice(0, 20)}`;
      const line = base(
        id,
        p ? Object.values(p.data.name)[0] : key,
        'equipment',
        key,
        equipmentTemplate!.data.budgetKey,
        1,
        'pcs',
      );
      line.productRef = p ? assetRef(p) : undefined;
      line.dimensionsMm = p?.data.dimensionsMm;
      derived.push(line);
    }
  draft.lines = [...draft.lines.filter((l) => !derived.some((d) => d.id === l.id)), ...derived];
  addSources(
    draft,
    [...menus, ...recipes, ...products, ...equipment, ...templates].map((r) => assetRef(r)),
  );
  return result(BomDraft.parse(draft), needs);
}
export const deriveMenuLinesStep = {
  id: 'fitout-bom/deriveMenuLines',
  input: DeriveInput,
  output: BomDraft,
  reads: ['menu', 'recipe', 'product', 'line-template'],
  params: [
    {
      key: 'food.openingCoverDays',
      required: false,
      description: 'Opening inventory coverage days',
    },
  ],
  run: deriveMenuLines,
} satisfies StepDef<typeof DeriveInput, typeof BomDraft>;
