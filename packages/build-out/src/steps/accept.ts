import {
  type AssetRef,
  type BuildPlanBody,
  type Measure,
  type Need,
  type StepDef,
  type Verification,
  convertMeasure,
  meets,
  stepResult,
  versionHash,
  z,
} from '@osw/core';
import {
  PARAMS,
  approval,
  approvalNeed,
  assertUnique,
  inputNeed,
  loadTemplate,
  numericParam,
  parameterRefs,
  parametersAreExamples,
  uniqueRefs,
  verification,
  withinPct,
} from '../helpers.js';
import { BuildPlan, Tracked } from '../models.js';
import { topologicalOrder } from '../rules/cpm.js';
import { AcceptanceTemplate } from '../slots.js';

type Acceptance = z.infer<typeof BuildPlanBody>['acceptance'];
export function acceptanceSubject(value: Acceptance) {
  const { status: _status, acceptedAt: _acceptedAt, ...content } = value;
  return content;
}
function compareMeasure(actual: Measure, expected: Measure, tolerance: number) {
  if (typeof expected.value !== 'number')
    return { holds: actual.value === expected.value, value: actual.value };
  if (typeof actual.value !== 'number') return { holds: false, value: String(actual.value) };
  if (expected.unit) {
    const converted = convertMeasure(actual, expected.unit);
    if (!converted.value || typeof converted.value.value !== 'number')
      return { holds: false, value: actual.value };
    return {
      holds: withinPct(converted.value.value, expected.value, tolerance),
      value: converted.value.value,
    };
  }
  return {
    holds: !actual.unit && withinPct(actual.value, expected.value, tolerance),
    value: actual.value,
  };
}
export const accept: StepDef<typeof Tracked, typeof BuildPlan> = {
  id: 'build-out/accept',
  input: Tracked,
  output: BuildPlan,
  reads: ['template', 'params'],
  params: PARAMS.filter((p) => p.key === 'verify.siteMeasure.tolerancePct'),
  approval: {
    question: 'Owner accepts or rejects completion?',
    decision: z.enum(['accept', 'reject']),
  },
  async run(raw, ctx) {
    const state = Tracked.parse(raw);
    const { input, quote, schedule } = state;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const template = await loadTemplate(
      ctx,
      input,
      input.acceptanceTemplateId,
      'buildout-acceptance',
      AcceptanceTemplate,
      needs,
    );
    const tolerance = numericParam(ctx, 'verify.siteMeasure.tolerancePct', input, needs);
    if (!template || tolerance === null) return { output: null, needs, verifications };
    const evidence = input.acceptance;
    for (const [keys, name] of [
      [evidence.installed.map((v) => v.lineId), 'installed line'],
      [evidence.asBuilt.map((v) => v.key), 'as-built condition'],
      [evidence.observedDeliveries.map((v) => v.lineId), 'delivery observation'],
      [evidence.checklist.map((v) => v.key), 'checklist item'],
      [evidence.punch.map((v) => v.id), 'punch item'],
      [evidence.landlord.map((v) => v.item), 'landlord item'],
    ] as const)
      assertUnique(keys, name);
    const items = topologicalOrder(
      template.content.items.map((item) => ({ ...item, id: item.key })),
    );
    const missing = (path: string, reason: string) => needs.push(inputNeed(path, reason, false));
    for (const check of evidence.checklist)
      if (!items.some((i) => i.key === check.key))
        needs.push(inputNeed(`acceptance.checklist.${check.key}`, 'Unknown checklist item'));
    for (const line of [...evidence.installed, ...evidence.observedDeliveries])
      if (!quote.lines.some((l) => l.id === line.lineId))
        needs.push(inputNeed(`acceptance.lines.${line.lineId}`, 'Unknown construction line'));
    const checklist: Acceptance['checklist'] = [];
    for (const { id: _id, ...item } of items) {
      const answer = evidence.checklist.find((v) => v.key === item.key);
      const done =
        answer?.done === true &&
        (!item.evidence || answer.evidenceRefs.length > 0) &&
        item.dependsOn.every((key) => checklist.some((v) => v.key === key && v.done));
      checklist.push({ ...item, done, evidenceRefs: answer?.evidenceRefs ?? [] });
    }
    const punch: Acceptance['punch'] = [...evidence.punch];
    const lineChecks: Acceptance['lineChecks'] = quote.lines.map((line) => {
      const installed = evidence.installed.find((v) => v.lineId === line.id);
      const arrivals = input.delivery.body.arrivals.filter(
        (v) => v.bomLineId === (line.bomLineId ?? line.id),
      );
      const observed = evidence.observedDeliveries.find((v) => v.lineId === line.id);
      const local = !arrivals.length && input.localAvailability[line.id] !== undefined;
      const deliveredQty =
        observed?.receivedQty ??
        (arrivals.length && arrivals.every((v) => v.receivedQty !== null)
          ? arrivals.reduce((s, v) => s + (v.receivedQty ?? 0), 0)
          : null);
      const damagedQty =
        observed?.damagedQty ?? arrivals.reduce((s, v) => s + (v.damagedQty ?? 0), 0);
      if (!installed)
        missing(`acceptance.installed.${line.id}`, 'Installation quantity must be observed');
      if (deliveredQty === null && !local)
        missing(`acceptance.delivered.${line.id}`, 'Expected delivery is not a receipt');
      const pending = !installed || (deliveredQty === null && !local);
      return {
        lineId: line.id,
        expectedQty: line.qty,
        deliveredQty,
        damagedQty,
        installedQty: installed?.qty ?? 0,
        verdict: pending
          ? 'pending'
          : installed.qty === line.qty &&
              (deliveredQty === null || deliveredQty - damagedQty >= installed.qty)
            ? 'holds'
            : 'fails',
      };
    });
    const siteChecks: Acceptance['siteChecks'] = [];
    const listingRefs = uniqueRefs([
      input.site.body.listing,
      ...input.site.sources.filter((r) => r.slot === input.site.body.listing.slot),
    ]);
    for (const reading of input.site.body.conditions) {
      const measured = evidence.asBuilt.find((v) => v.key === reading.key);
      if (!measured) {
        missing(`acceptance.asBuilt.${reading.key}`, 'A completion measurement is required');
        continue;
      }
      const inScope = input.changedConditions.includes(reading.key);
      const comparison = compareMeasure(measured.measure, reading.measure, tolerance);
      const met = reading.required
        ? meets(reading.required, { key: reading.key, measure: measured.measure })
        : null;
      const verdict = met
        ? met.value === null
          ? 'pending'
          : met.value
            ? 'holds'
            : 'fails'
        : inScope || comparison.holds
          ? 'holds'
          : 'fails';
      if (met) needs.push(...met.needs.map((n) => ({ ...n, blocking: false })));
      siteChecks.push({
        key: reading.key,
        inScope,
        required: reading.required,
        measure: reading.measure,
        asBuilt: measured.measure,
        verdict,
      });
      if (!inScope)
        for (const ref of listingRefs)
          verifications.push(
            verification(
              ctx,
              ref,
              accept.id,
              `condition.${reading.key}`,
              String(reading.measure.value),
              String(comparison.value),
              comparison.holds,
              reading.measure.unit,
            ),
          );
    }
    const landlordChecks: Acceptance['landlordChecks'] = (
      input.site.body.lease?.landlordWork ?? []
    ).map((item, index) => {
      const observed = evidence.landlord.find((v) => v.item === item);
      const delivered = observed?.delivered === true && observed.evidenceRefs.length > 0;
      if (!delivered)
        punch.push({
          id: `landlord:${index}`,
          title: item,
          severity: 'blocking',
          owner: 'landlord',
        });
      return {
        item,
        delivered,
        verdict: delivered ? 'holds' : 'fails',
        evidenceRefs: observed?.evidenceRefs ?? [],
      };
    });
    const promised = input.site.body.lease?.deliveryCondition;
    let possession: Acceptance['possession'];
    if (promised) {
      const observed = evidence.possession?.observed ?? '';
      possession = {
        promised,
        observed,
        verdict: !observed ? 'pending' : observed === promised ? 'holds' : 'fails',
      };
      if (possession.verdict !== 'holds')
        punch.push({
          id: 'landlord:possession',
          title: 'Lease delivery condition not evidenced',
          severity: 'blocking',
          owner: 'landlord',
        });
    }
    const landlordRefs = uniqueRefs([...listingRefs, ...(input.landlord ? [input.landlord] : [])]);
    for (const ref of landlordRefs) {
      verifications.push(
        verification(
          ctx,
          ref,
          accept.id,
          'landlordWork',
          landlordChecks.length,
          landlordChecks.filter((c) => c.delivered).length,
          landlordChecks.every((c) => c.delivered),
        ),
      );
      if (possession?.observed)
        verifications.push(
          verification(
            ctx,
            ref,
            accept.id,
            'deliveryCondition',
            possession.promised,
            possession.observed,
            possession.verdict === 'holds',
          ),
        );
    }
    const deliveryRefs = uniqueRefs(
      input.delivery.body.shipments.flatMap((s) =>
        'partyRef' in s.carrier ? [s.carrier.partyRef] : [],
      ),
    );
    for (const ref of deliveryRefs) {
      const ids = new Set(
        input.delivery.body.shipments
          .filter((s) => 'partyRef' in s.carrier && s.carrier.partyRef.id === ref.id)
          .flatMap((s) => s.lines.map((l) => l.bomLineId)),
      );
      const checks = lineChecks.filter((c) =>
        ids.has(quote.lines.find((l) => l.id === c.lineId)?.bomLineId ?? c.lineId),
      );
      if (checks.length && checks.every((c) => c.deliveredQty !== null)) {
        const expected = checks.reduce((s, c) => s + c.expectedQty, 0);
        const actual = checks.reduce((s, c) => s + (c.deliveredQty ?? 0) - c.damagedQty, 0);
        verifications.push(
          verification(
            ctx,
            ref,
            accept.id,
            'deliveredQty',
            expected,
            actual,
            checks.every(
              (c) => (c.deliveredQty ?? 0) - c.damagedQty >= c.expectedQty && c.damagedQty === 0,
            ),
          ),
        );
      }
    }
    const actualFinish =
      evidence.actualFinish ??
      (schedule.tasks.every((t) => t.actual?.end)
        ? schedule.tasks
            .map((t) => t.actual?.end as string)
            .sort()
            .at(-1)
        : undefined);
    if (!actualFinish) missing('acceptance.actualFinish', 'Completion date must be observed');
    if (actualFinish && (actualFinish > ctx.now.slice(0, 10) || actualFinish < schedule.start))
      needs.push(
        inputNeed(
          'acceptance.actualFinish',
          'Completion date is outside the observed construction period',
        ),
      );
    if (input.contractor) {
      if (actualFinish)
        verifications.push(
          verification(
            ctx,
            input.contractor,
            accept.id,
            'finishDate',
            schedule.finish,
            actualFinish,
            actualFinish <= schedule.finish,
          ),
        );
      const blocking = punch.filter((p) => p.severity === 'blocking' && !p.closedAt).length;
      verifications.push(
        verification(
          ctx,
          input.contractor,
          accept.id,
          'blockingPunch',
          0,
          blocking,
          blocking === 0,
        ),
      );
    }
    for (const p of punch)
      if (
        (p.closedAt && p.closedAt > ctx.now.slice(0, 10)) ||
        (p.severity === 'minor' && !p.closedAt && !p.due)
      )
        missing(
          `acceptance.punch.${p.id}`,
          'Open minor work needs a due date; closure cannot be in the future',
        );
    for (const task of schedule.tasks)
      if (
        task.checkpoint &&
        !input.checkpoints.some(
          (c) => c.key === task.checkpoint && c.passedAt <= (actualFinish ?? ctx.now.slice(0, 10)),
        )
      )
        missing(`checkpoints.${task.checkpoint}`, 'Completion requires checkpoint evidence');
    const acceptance: Acceptance = {
      status: 'open',
      checklist,
      lineChecks,
      siteChecks,
      punch,
      landlordChecks,
      ...(possession ? { possession } : {}),
      handover: evidence.handover,
    };
    // 完工日期与阶段检查证据同样参与签名，避免改日期后继续使用旧批示。
    const hash = await versionHash({
      acceptance: acceptanceSubject(acceptance),
      actualFinish: actualFinish ?? null,
      checkpoints: input.checkpoints,
      quoteHash: quote.quoteHash,
    });
    const owner = approval(ctx, accept.id, hash, 'owner');
    const ready =
      !needs.length &&
      checklist.filter((c) => c.gate).every((c) => c.done) &&
      lineChecks.every((c) => c.verdict === 'holds') &&
      siteChecks.length === input.site.body.conditions.length &&
      siteChecks.every((c) => c.verdict === 'holds') &&
      landlordChecks.every((c) => c.verdict === 'holds') &&
      (!possession || possession.verdict === 'holds') &&
      !punch.some((p) => p.severity === 'blocking' && !p.closedAt);
    if (owner?.decision === 'reject') acceptance.status = 'rejected';
    else if (ready && owner?.decision === 'accept') {
      acceptance.status = punch.some((p) => p.severity === 'minor' && !p.closedAt)
        ? 'conditional'
        : 'accepted';
      acceptance.acceptedAt = owner.at;
    } else if (!owner || !['accept', 'reject'].includes(owner.decision))
      needs.push(
        approvalNeed(
          accept.id,
          hash,
          'Owner must review this completion evidence and date',
          undefined,
          ready,
        ),
      );
    const body = {
      drawings: input.drawings,
      landlordScope: input.landlordScope,
      quote,
      bids: state.bids,
      schedule,
      changes: state.changes,
      acceptance,
    };
    const artifactHash = await versionHash(body);
    const sources: AssetRef[] = uniqueRefs([
      ...state.sources,
      template.ref,
      ...parameterRefs(ctx, ['verify.siteMeasure.tolerancePct'], input),
      ...listingRefs,
      ...(input.landlord ? [input.landlord] : []),
    ]);
    return stepResult(
      BuildPlan.parse({
        kind: 'BuildPlan',
        artifactVersion: '0.1.0',
        id: `build-plan-${artifactHash.slice(0, 32)}`,
        hash: artifactHash,
        producedBy: { step: accept.id, pkg: '@osw/build-out', pkgVersion: '0.1.0' },
        storeId: input.bom.storeId,
        inputs: [input.site, input.bom, input.delivery].map(({ kind, id, hash }) => ({
          kind,
          id,
          hash,
        })),
        sources,
        createdAt: ctx.now,
        ...(state.example &&
        template.record.example === true &&
        (await parametersAreExamples(ctx, ['verify.siteMeasure.tolerancePct'], input))
          ? { example: true }
          : {}),
        body,
      }),
      needs,
      verifications,
    );
  },
};
