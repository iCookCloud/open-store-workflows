import {
  type Need,
  type StepDef,
  assetRef,
  isWithin,
  jurisdictionCovers,
  stepResult,
} from '@osw/core';
import { applicable, queryAll, uniqueRefs } from '../helpers.js';
import { Estimated, Takeoff } from '../models.js';
import { installRateSlot } from '../slots.js';

export const estimateHours: StepDef<typeof Takeoff, typeof Estimated> = {
  id: 'build-out/estimateHours',
  input: Takeoff,
  output: Estimated,
  reads: ['install-rate'],
  params: [],
  async run(raw, ctx) {
    const state = Takeoff.parse(raw);
    const needs: Need[] = [];
    const sources = [...state.sources];
    const groups = new Map<string, Takeoff['lines']>();
    for (const line of state.lines) {
      if (line.install?.overridden) continue;
      const key = JSON.stringify([line.unit, line.category, line.lineKind]);
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    let example = state.example;
    for (const lines of groups.values()) {
      const first = lines[0];
      const filter = {
        all: [
          ...(['unit', 'category', 'lineKind'] as const).map((field) =>
            first[field] === undefined
              ? { field: `match.${field}`, op: 'exists' as const, value: false }
              : {
                  any: [
                    {
                      field: `match.${field}`,
                      op: 'hasAny' as const,
                      value: [first[field] as string],
                    },
                    { field: `match.${field}`, op: 'exists' as const, value: false },
                  ],
                },
          ),
          jurisdictionCovers('coverage.jurisdictions', state.input.site.body.jurisdiction),
        ],
      };
      const candidates = (await queryAll(ctx, installRateSlot, filter)).filter((r) =>
        applicable(r, state.input),
      );
      const specificity = (js: string[]) =>
        Math.max(
          0,
          ...js
            .filter((j) => isWithin(state.input.site.body.jurisdiction, j))
            .map((j) => j.split('-').length),
        );
      candidates.sort(
        (a, b) =>
          b.data.priority - a.data.priority ||
          specificity(b.coverage.jurisdictions) - specificity(a.coverage.jurisdictions) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      for (const line of lines) {
        const candidate = candidates.find(
          ({ data }) =>
            data.unit === line.unit &&
            (!data.match.installKind || data.match.installKind === line.installKind) &&
            (!data.match.nameContains?.length ||
              data.match.nameContains.some((s) =>
                line.name.toLowerCase().includes(s.toLowerCase()),
              )),
        );
        if (!candidate) {
          needs.push({
            kind: 'asset',
            slot: 'install-rate',
            filter,
            reason: `No applicable rate for line ${line.id}`,
            blocking: true,
          });
          continue;
        }
        line.install = {
          hoursPerUnit: candidate.data.hoursPerUnit,
          basis: candidate.data.basis,
          rateRef: assetRef(candidate),
          overridden: false,
        };
        line.trade = candidate.data.trade;
        sources.push(assetRef(candidate));
        example &&= candidate.example === true;
      }
    }
    if (needs.some((n) => n.blocking)) return { output: null, needs, verifications: [] };
    return stepResult(Estimated.parse({ ...state, sources: uniqueRefs(sources), example }));
  },
};
