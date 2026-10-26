import { AudienceRule, type Store, isWithin, type z } from '@osw/core';
import type { SegmentRuleset } from './models.js';

type Rule = z.infer<typeof AudienceRule>;
export const normalizedValues = (values: readonly string[]) =>
  [...new Set(values.map((v) => v.trim().toLowerCase()))].sort();
export function normalizeRule(rule: Rule): Rule {
  const parsed = AudienceRule.parse(rule);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, normalizedValues(value!)]),
  );
}
function regions(rule: Rule, ruleset?: SegmentRuleset): string[] | undefined {
  return rule.regions
    ?.flatMap(
      (value) =>
        ruleset?.regionTiers[value] ??
        Object.entries(ruleset?.regionTiers ?? {}).find(
          ([k]) => k.toLowerCase() === value.toLowerCase(),
        )?.[1] ?? [value],
    )
    .map((v) => v.toUpperCase());
}
export function narrowerThan(variant: Rule, topic: Rule, ruleset?: SegmentRuleset): boolean {
  const v = normalizeRule(variant);
  const t = normalizeRule(topic);
  for (const axis of ['tracks', 'categories'] as const) {
    if (t[axis] && (!v[axis] || !v[axis]!.every((entry) => t[axis]!.includes(entry)))) return false;
  }
  const vr = regions(v, ruleset);
  const tr = regions(t, ruleset);
  return !tr || (!!vr && vr.every((region) => tr.some((prefix) => isWithin(region, prefix))));
}
export interface RuleSubject {
  track: string;
  jurisdiction: string;
  categories?: readonly string[];
}
export function matchRule(rule: Rule, subject: RuleSubject, ruleset?: SegmentRuleset): boolean {
  const normalized = normalizeRule(rule);
  if (normalized.tracks && !normalized.tracks.includes(subject.track.toLowerCase())) return false;
  const rs = regions(normalized, ruleset);
  if (rs && !rs.some((prefix) => isWithin(subject.jurisdiction.toUpperCase(), prefix)))
    return false;
  return (
    !normalized.categories ||
    normalized.categories.some((category) => {
      const alias = Object.entries(ruleset?.categoryAliases ?? {}).find(
        ([raw]) => raw.toLowerCase() === category,
      )?.[1];
      return (
        alias === subject.track ||
        subject.categories?.some((value) => value.toLowerCase() === category)
      );
    })
  );
}
export function pickVariant<T extends { variantKey: string; rule: Rule }>(
  variants: readonly T[],
  subject: RuleSubject,
  ruleset?: SegmentRuleset,
): T | undefined {
  return [...variants]
    .sort((a, b) => (a.variantKey < b.variantKey ? -1 : a.variantKey > b.variantKey ? 1 : 0))
    .find((variant) => matchRule(variant.rule, subject, ruleset));
}
export function storeSubject(
  store: Store,
  ruleset: SegmentRuleset,
  categoryRaw?: string,
): RuleSubject {
  return {
    track: store.track,
    jurisdiction: store.jurisdiction,
    categories: [
      ...(store.storeType ? [store.storeType] : []),
      ...(categoryRaw ? [categoryRaw] : []),
    ],
  };
}
