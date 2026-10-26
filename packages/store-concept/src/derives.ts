import { MenuDerives as SharedMenuDerives, type StoreSpecBody, type z } from '@osw/core';

export const MenuDerives = SharedMenuDerives;
export type MenuDerives = z.infer<typeof MenuDerives>;
export function inspectDerives(value: unknown): {
  valid: boolean;
  missing: boolean;
  derives: MenuDerives | null;
} {
  if (value === undefined || value === null) return { valid: false, missing: true, derives: null };
  const parsed = MenuDerives.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.ingredients.length + parsed.data.equipment.length + parsed.data.sop.length === 0
  )
    return { valid: false, missing: false, derives: null };
  return { valid: true, missing: false, derives: parsed.data };
}
export function mergeDerives(
  values: readonly unknown[],
  nonFood: boolean,
): z.infer<typeof StoreSpecBody>['downstream'] {
  const inspected = values.map(inspectDerives);
  const valid = inspected.flatMap((item) => (item.derives ? [item.derives] : []));
  const merge = (key: 'ingredients' | 'equipment' | 'sop') => {
    const terms = new Map<string, { key: string; label?: string }>();
    for (const derives of valid)
      for (const term of derives[key]) if (!terms.has(term.key)) terms.set(term.key, term);
    return [...terms.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };
  return {
    ingredients: nonFood ? [] : merge('ingredients'),
    equipment: merge('equipment'),
    sop: merge('sop'),
    coldchain: nonFood
      ? false
      : valid.some((derives) => derives.coldchain)
        ? true
        : inspected.some((item) => !item.valid)
          ? null
          : false,
  };
}
