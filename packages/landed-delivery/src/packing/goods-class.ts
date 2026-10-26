import type { Product } from '@osw/core';
const nonfood = [
  '双头煮面炉',
  '煮面炉',
  '茶几',
  '设备',
  '冰箱',
  '餐具',
  '桌',
  '椅',
  '炉',
  '柜',
  'noodle cooker',
  'tea table',
  'equipment',
  'table',
  'chair',
  'freezer',
  'oven',
  'utensil',
];
const food = [
  '面条',
  '茶叶',
  '大米',
  '食材',
  '食品',
  '调料',
  '酱料',
  'noodles',
  'rice',
  'food',
  'ingredient',
  'sauce',
  'tea leaves',
];
export function classifyGoods(product: Partial<Product>, category: string, name: string) {
  if (product.goodsClass) return { goodsClass: product.goodsClass, src: 'asset' as const };
  for (const text of [category, name].map((value) => value.toLowerCase())) {
    if (nonfood.some((word) => text.includes(word)))
      return { goodsClass: 'nonfood' as const, src: 'derived' as const };
    if (food.some((word) => text.includes(word)))
      return { goodsClass: 'food' as const, src: 'derived' as const };
  }
  return { goodsClass: 'nonfood' as const, src: 'derived' as const };
}
