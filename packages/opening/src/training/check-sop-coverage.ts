import { AssetRef, MenuSlot, type Need, type StepDef, assetRef, z } from '@osw/core';
import { CourseSlot } from '../slots/course.js';
import { RoleSlot } from '../slots/role.js';
import {
  jurisdictionFit,
  parseInput,
  readTrainingRef,
  trackFilter,
  trainingQuery,
  trainingResult,
  trainingVerification,
} from './helpers.js';
import { TrainingScope } from './models.js';
export const CheckSopCoverageInput = TrainingScope.extend({
  menuRef: AssetRef,
  openStations: z.array(z.string()),
});
export const CheckSopCoverageOutput = z.object({
  covered: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  missing: z.array(z.string()),
  sources: z.array(AssetRef),
});
export const checkSopCoverage: StepDef<
  typeof CheckSopCoverageInput,
  typeof CheckSopCoverageOutput
> = {
  id: 'opening/checkSopCoverage',
  input: CheckSopCoverageInput,
  output: CheckSopCoverageOutput,
  reads: ['menu', 'course', 'role'],
  params: [],
  async run(raw, ctx) {
    const parsed = parseInput(CheckSopCoverageInput, raw);
    if (!parsed.value) return trainingResult(null, parsed.needs);
    const input = parsed.value;
    const needs: Need[] = [];
    const menu = await readTrainingRef(ctx, MenuSlot, input.menuRef, needs);
    if (!menu) return trainingResult(null, needs);
    if (!menu.data.items)
      return trainingResult(null, [
        {
          kind: 'input',
          path: 'menu.items',
          reason: 'Menu item coverage has not been catalogued',
          blocking: true,
        },
      ]);
    const courses = (await trainingQuery(ctx.assets, CourseSlot, trackFilter(input.track))).filter(
      (r) => jurisdictionFit(input.jurisdiction, r.coverage.jurisdictions) !== 'no',
    );
    const coveredIds = new Set(courses.flatMap((r) => r.data.units.flatMap((u) => u.covers)));
    const missing = menu.data.items
      .filter((item) => !coveredIds.has(item.id))
      .map((item) => item.id);
    for (const id of missing)
      needs.push({
        kind: 'action',
        action: 'mapDishToSop',
        ref: id,
        reason: 'Menu item has no explicitly mapped course unit',
        blocking: false,
      });
    if (!courses.length)
      needs.push({
        kind: 'asset',
        slot: 'course',
        filter: trackFilter(input.track),
        reason: 'No applicable course units',
        blocking: false,
      });
    const verifications = courses.map((course) =>
      trainingVerification(
        assetRef(course),
        'opening/checkSopCoverage',
        missing.length ? 'fails' : 'holds',
        'menuCoverage',
        missing.length
          ? 'Menu has items without mapped course coverage'
          : 'All menu items have mapped course coverage',
        ctx,
        {
          measured: {
            field: 'menuCoverage',
            expected: menu.data.items!.length,
            actual: menu.data.items!.length - missing.length,
          },
          evidence: missing.slice(0, 20),
        },
      ),
    );
    const missingStations = [
      ...new Set(
        menu.data.items.flatMap((item) =>
          item.station && !input.openStations.includes(item.station) ? [item.station] : [],
        ),
      ),
    ];
    for (const station of missingStations) {
      needs.push({
        kind: 'input',
        path: `staffing.${station}`,
        reason: 'Menu station has no planned or active staffing',
        blocking: false,
      });
      const roles = await trainingQuery(ctx.assets, RoleSlot, {
        field: 'stationKey',
        op: 'eq',
        value: station,
      });
      for (const role of roles)
        verifications.push(
          trainingVerification(
            assetRef(role),
            'opening/planStaffing',
            'fails',
            'stationStaffed',
            'Menu station has no planned or active staffing',
            ctx,
            { evidence: [station] },
          ),
        );
    }
    return trainingResult(
      {
        covered: menu.data.items.length - missing.length,
        total: menu.data.items.length,
        missing,
        sources: [assetRef(menu), ...courses.map((r) => assetRef(r))],
      },
      needs,
      verifications,
    );
  },
};
