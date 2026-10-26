import {
  type Need,
  type SpecRequirement as SpecRequirementSchema,
  convertUnit,
  validateRequirement,
  type z,
} from '@osw/core';

export type SpecRequirement = z.infer<typeof SpecRequirementSchema>;
export function mergeRequirements(requirements: readonly SpecRequirement[]): {
  requirements: SpecRequirement[];
  needs: Need[];
} {
  const needs: Need[] = [];
  const merged: SpecRequirement[] = [];
  const groups = new Map<string, SpecRequirement[]>();
  for (const requirement of requirements) {
    const list = groups.get(requirement.key) ?? [];
    list.push(requirement);
    groups.set(requirement.key, list);
  }
  for (const key of [...groups.keys()].sort()) {
    const original = groups.get(key)!;
    // 硬要求覆盖同一条件的软偏好，不能把软偏好抬成硬条件。
    const hard = original.some((requirement) => requirement.hard);
    const group = hard ? original.filter((requirement) => requirement.hard) : original;
    const unit = group.find((requirement) => requirement.unit)?.unit;
    let conflict = false;
    const fail = (reason: string) => {
      if (!conflict)
        needs.push({
          kind: 'action',
          action: 'resolveRequirementConflict',
          ref: key,
          reason,
          blocking: true,
        });
      conflict = true;
    };
    const normalized: SpecRequirement[] = group.map((requirement): SpecRequirement => {
      try {
        validateRequirement(requirement);
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Invalid requirement');
      }
      if (!unit || requirement.op === 'present') return requirement;
      if (!requirement.unit) {
        fail('A numeric condition has inconsistent or missing units');
        return requirement;
      }
      const values = Array.isArray(requirement.value) ? requirement.value : [requirement.value!];
      const converted = values.map((value) => {
        if (typeof value !== 'number') {
          fail('Units can only be applied to numeric requirements');
          return value;
        }
        const conversion = convertUnit(value, requirement.unit!, unit);
        if (conversion.value === null) {
          fail('Requirements use incompatible unit families');
          return value;
        }
        return conversion.value;
      });
      return {
        ...requirement,
        unit,
        value: Array.isArray(requirement.value) ? converted : converted[0],
      };
    });
    if (conflict) continue;
    const lower = normalized
      .filter((requirement) => requirement.op === 'gte')
      .sort((a, b) => Number(b.value) - Number(a.value))[0];
    const upper = normalized
      .filter((requirement) => requirement.op === 'lte')
      .sort((a, b) => Number(a.value) - Number(b.value))[0];
    if (lower && upper && Number(lower.value) > Number(upper.value))
      fail('Lower bound exceeds upper bound');
    const sets = normalized.filter(
      (requirement) => requirement.op === 'eq' || requirement.op === 'in',
    );
    let allowed: (string | number | boolean)[] | null = null;
    for (const requirement of sets) {
      const next = Array.isArray(requirement.value) ? requirement.value : [requirement.value!];
      allowed =
        allowed === null
          ? [...new Set(next)]
          : allowed.filter((value) =>
              next.some((candidate) =>
                typeof candidate === 'number' && typeof value === 'number'
                  ? Math.abs(candidate - value) <= 1e-9 * Math.max(1, Math.abs(value))
                  : candidate === value,
              ),
            );
    }
    if (allowed) {
      allowed = allowed.filter(
        (value) =>
          (!lower || (typeof value === 'number' && value >= Number(lower.value))) &&
          (!upper || (typeof value === 'number' && value <= Number(upper.value))),
      );
      if (!allowed.length) fail('Requirements have no common allowed value');
    }
    if (conflict) continue;
    if (allowed) {
      const first = sets[0]!;
      merged.push({
        ...first,
        hard,
        op: allowed.length === 1 ? 'eq' : 'in',
        value: allowed.length === 1 ? allowed[0] : allowed,
      });
    } else {
      if (lower) merged.push(lower);
      if (upper) merged.push(upper);
      if (!lower && !upper) {
        const present = normalized.find((requirement) => requirement.op === 'present');
        if (present) merged.push(present);
      }
    }
  }
  return { requirements: merged, needs };
}
