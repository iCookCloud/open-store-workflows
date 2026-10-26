import { type Approval, type Need, type StepCtx, versionHash } from '@osw/core';
export async function approvalFor(
  ctx: StepCtx,
  step: string,
  subject: string | undefined,
  value: unknown,
  decision: string,
  needs: Need[],
  role?: string,
  prehashed = false,
): Promise<Approval | undefined> {
  const subjectHash = prehashed ? String(value) : await versionHash(value);
  const candidates = ctx.approvals
    .filter(
      (a) =>
        a.step === step &&
        a.subject === subject &&
        a.subjectHash === subjectHash &&
        a.at <= ctx.now,
    )
    .sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
  const latest = candidates[0];
  // 同一时刻冲突批示不猜测；撤回或拒绝会覆盖较旧的同意。
  if (
    latest?.decision === decision &&
    (!role || (latest.role === role && latest.party)) &&
    candidates.filter((a) => a.at === latest.at).every((a) => a.decision === decision)
  )
    return latest;
  needs.push({
    kind: 'approval',
    step,
    ...(subject ? { subject } : {}),
    subjectHash,
    question: `${decision}: ${subject || step}`,
    blocking: true,
  });
  return undefined;
}
