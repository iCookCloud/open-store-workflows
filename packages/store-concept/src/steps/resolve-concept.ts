import {
  type AssetRecordOf,
  type Filter,
  type StepDef,
  isWithin,
  jurisdictionCovers,
} from '@osw/core';
import { ConceptBrief } from '../brief.js';
import { blocked, inputNeeds, queryAll, result } from '../helpers.js';
import { ConceptDraft } from '../models.js';
import { calcTemplateSlot } from '../slots/calc-template.js';
import { siteProfileSlot } from '../slots/site-profile.js';

function mostSpecific<T>(records: AssetRecordOf<T>[], jurisdiction: string) {
  const score = (record: AssetRecordOf<T>) =>
    Math.max(
      0,
      ...record.coverage.jurisdictions
        .filter((parent) => isWithin(jurisdiction, parent))
        .map((parent) => parent.split('-').length),
    );
  const max = Math.max(-1, ...records.map(score));
  return records.filter((record) => score(record) === max);
}
export const resolveConcept: StepDef<typeof ConceptBrief, typeof ConceptDraft> = {
  id: 'store-concept/resolveConcept',
  input: ConceptBrief,
  output: ConceptDraft,
  reads: ['calc-template', 'site-profile'],
  params: [],
  async run(raw, ctx) {
    const parsed = ConceptBrief.safeParse(raw);
    if (!parsed.success) return blocked(inputNeeds(parsed.error));
    const brief = parsed.data;
    const clauses: Filter[] = [jurisdictionCovers('coverage.jurisdictions', brief.jurisdiction)];
    if (brief.storeType) clauses.push({ field: 'storeType', op: 'eq', value: brief.storeType });
    if (brief.cuisine) clauses.push({ field: 'cuisines', op: 'hasAny', value: [brief.cuisine] });
    const filter: Filter = { all: clauses };
    const templates = mostSpecific(
      await queryAll(ctx.assets, calcTemplateSlot, filter),
      brief.jurisdiction,
    );
    if (templates.length === 0)
      return blocked([
        {
          kind: 'asset',
          slot: 'calc-template',
          filter,
          reason: 'No compatible concept template exists',
          blocking: true,
        },
      ]);
    if (templates.length > 1)
      return blocked([
        {
          kind: 'input',
          path: 'storeType',
          reason:
            'Multiple equally specific concept templates match; choose a unique store type or correct duplicate assets',
          blocking: true,
        },
      ]);
    const template = templates[0]!;
    const profileFilter: Filter = {
      all: [
        { field: 'storeType', op: 'eq', value: template.data.storeType },
        jurisdictionCovers('coverage.jurisdictions', brief.jurisdiction),
      ],
    };
    const profiles = mostSpecific(
      await queryAll(ctx.assets, siteProfileSlot, profileFilter),
      brief.jurisdiction,
    );
    if (profiles.length === 0)
      return blocked([
        {
          kind: 'asset',
          slot: 'site-profile',
          filter: profileFilter,
          reason: 'No compatible site profile exists',
          blocking: true,
        },
      ]);
    if (profiles.length > 1)
      return blocked([
        {
          kind: 'input',
          path: 'storeType',
          reason: 'Multiple equally specific site profiles match',
          blocking: true,
        },
      ]);
    return result({ brief, template, profile: profiles[0]! });
  },
};
