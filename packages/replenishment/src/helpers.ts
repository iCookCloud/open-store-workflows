import type {
  AssetReader,
  AssetRecordOf,
  Filter,
  Need,
  Page,
  ParamScope,
  SlotDef,
  StepCtx,
  StepResult,
  Verification,
  z,
} from '@osw/core';

export { assetRef } from '@osw/core';
export function result<O>(
  output: O,
  needs: Need[] = [],
  verifications: Verification[] = [],
): StepResult<O> {
  return { output: needs.some((need) => need.blocking) ? null : output, needs, verifications };
}
export function blocked<O>(needs: Need[], verifications: Verification[] = []): StepResult<O> {
  return { output: null, needs, verifications };
}
export function inputNeeds(error: z.ZodError): Need[] {
  return error.issues.map((issue) => ({
    kind: 'input',
    path: issue.path.map(String).join('.') || 'input',
    reason: issue.message,
    blocking: true,
  }));
}
export async function queryAll<S extends z.ZodObject>(
  assets: AssetReader,
  slot: SlotDef<S>,
  filter: Filter | null,
  limit = 200,
): Promise<AssetRecordOf<z.infer<S>>[]> {
  const records: AssetRecordOf<z.infer<S>>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: Page<z.infer<S>> = await assets.query(slot, filter, { limit, cursor });
    records.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor))
      throw new Error('Asset source returned a repeated pagination cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return records;
}
export function numericParam(
  ctx: StepCtx,
  key: string,
  needs: Need[],
  options: { min?: number; max?: number; integer?: boolean } = {},
  scope: ParamScope = {},
): number | null {
  const found = ctx.params.get(key, scope);
  if (!found) {
    needs.push(
      ctx.params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
    );
    return null;
  }
  if (
    typeof found.value !== 'number' ||
    !Number.isFinite(found.value) ||
    (options.min !== undefined && found.value < options.min) ||
    (options.max !== undefined && found.value > options.max) ||
    (options.integer && !Number.isInteger(found.value))
  ) {
    needs.push({
      kind: 'input',
      path: `params.${key}`,
      reason: 'Parameter is outside its declared numeric range',
      blocking: true,
    });
    return null;
  }
  return found.value;
}
export function stringParam(
  ctx: StepCtx,
  key: string,
  needs: Need[],
  scope: ParamScope = {},
): string | null {
  const found = ctx.params.get(key, scope);
  if (!found) {
    needs.push(
      ctx.params.need?.(key, scope) ?? { kind: 'param', key, reason: 'missing', blocking: true },
    );
    return null;
  }
  if (typeof found.value !== 'string' || !found.value.trim()) {
    needs.push({
      kind: 'input',
      path: `params.${key}`,
      reason: 'Parameter must be a nonempty string',
      blocking: true,
    });
    return null;
  }
  return found.value;
}
export function approvalNeed(
  ctx: StepCtx,
  step: string,
  subject: string,
  hash: string,
  decision: string,
  roles?: readonly string[],
): Need | undefined {
  const approval = currentApproval(ctx, step, subject, hash);
  if (
    approval?.decision === decision &&
    (!roles || (approval.role && roles.includes(approval.role)))
  )
    return undefined;
  return {
    kind: 'approval',
    step,
    subject,
    subjectHash: hash,
    question: `Approve ${decision} for ${subject}${roles ? ` as ${roles.join(' or ')}` : ''}`,
    blocking: true,
  };
}

export function currentApproval(ctx: StepCtx, step: string, subject: string, hash: string) {
  return ctx.approvals
    .filter(
      (item) =>
        item.step === step &&
        item.subject === subject &&
        item.subjectHash === hash &&
        Date.parse(item.at) <= Date.parse(ctx.now),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}
