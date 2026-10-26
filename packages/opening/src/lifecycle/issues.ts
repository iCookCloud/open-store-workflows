import { IsoDate, type Need, type Verification, todayIn, z } from '@osw/core';
import { defineStep, inputNeed, result, validArtifact, verification } from '../helpers.js';
import { BuildPlan, DeliveryPlan, Issue, Timezone } from './models.js';
export const ImportIssuesInput = z.object({
  issues: z.array(Issue).default([]),
  updates: z.array(Issue).default([]),
  buildPlan: BuildPlan.optional(),
  deliveryPlan: DeliveryPlan.optional(),
  stockRequiredOn: IsoDate,
  timezone: Timezone,
});
export const importUpstreamIssues = defineStep({
  id: 'opening/importUpstreamIssues',
  input: ImportIssuesInput,
  output: z.array(Issue),
  reads: [],
  params: [],
  async run(input, ctx) {
    const needs: Need[] = [];
    const checks: Verification[] = [];
    const today = todayIn(input.timezone, ctx.now);
    const issues = new Map<string, z.infer<typeof Issue>>();
    for (const issue of [...input.issues, ...input.updates]) {
      if (issue.status === 'closed' && (!issue.verificationNote?.trim() || !issue.closedOn))
        needs.push(
          inputNeed(
            `issues.${issue.id}`,
            'Closing an issue requires closedOn and verificationNote',
          ),
        );
      const { closedOn: _closedOn, ...open } = issue;
      issues.set(issue.id, issue.status === 'closed' ? issue : open);
    }
    if (input.buildPlan) {
      needs.push(...(await validArtifact(input.buildPlan, 'buildPlan.hash')));
      const acceptance = input.buildPlan.body.acceptance;
      for (const punch of acceptance.punch) {
        const id = `build:${input.buildPlan.storeId}:${punch.id}`;
        const old = issues.get(id);
        if (!punch.closedAt)
          issues.set(id, {
            id,
            area: 'build',
            severity: punch.severity === 'blocking' ? 'P0' : 'P1',
            status: old?.status === 'closed' ? 'open' : (old?.status ?? 'open'),
            refs: input.buildPlan.sources,
            openedOn: old?.openedOn ?? today,
          });
        else if (old)
          issues.set(id, {
            ...old,
            status: 'closed',
            closedOn: punch.closedAt,
            verificationNote: 'Resolved in the upstream BuildPlan',
          });
      }
      if (acceptance.status === 'accepted') {
        const failures = [...issues.values()].filter(
          (issue) =>
            issue.severity === 'P0' &&
            ['build', 'equipment'].includes(issue.area) &&
            Boolean(
              acceptance.acceptedAt &&
                (issue.status !== 'closed' || issue.openedOn > acceptance.acceptedAt.slice(0, 10)),
            ),
        );
        if (failures.length)
          for (const source of input.buildPlan.sources)
            checks.push(
              verification(
                ctx,
                source,
                'opening/importUpstreamIssues',
                'acceptance',
                'fails',
                'P0 issues followed accepted construction',
                failures.map((issue) => issue.id),
              ),
            );
      }
    } else needs.push(inputNeed('buildPlan', 'Build acceptance must be confirmed manually', false));
    if (input.deliveryPlan) {
      needs.push(...(await validArtifact(input.deliveryPlan, 'deliveryPlan.hash')));
      const stock = input.deliveryPlan.body.openingStock;
      const id = `delivery:${input.deliveryPlan.storeId}:openingStock`;
      const old = issues.get(id);
      const received =
        stock.lastAt.basis === 'received' && stock.lastAt.date && stock.lastAt.date <= today;
      const late = stock.lastAt.date && stock.lastAt.date > input.stockRequiredOn;
      const overdue = today >= input.stockRequiredOn && !received;
      if (received && old) {
        issues.set(id, {
          ...old,
          status: 'closed',
          closedOn: stock.lastAt.date!,
          verificationNote: 'Opening stock physically received',
        });
      } else if (overdue || late) {
        issues.set(id, {
          id,
          area: 'stock',
          severity: overdue ? 'P0' : 'P1',
          status: old?.status === 'closed' ? 'open' : (old?.status ?? 'open'),
          refs: input.deliveryPlan.sources,
          openedOn: old?.openedOn ?? today,
        });
      } else if (
        old &&
        stock.lastAt.date &&
        stock.lastAt.date <= input.stockRequiredOn &&
        today < input.stockRequiredOn
      ) {
        issues.set(id, {
          ...old,
          status: 'closed',
          closedOn: today,
          verificationNote: 'Revised arrival forecast meets the required date',
        });
      }
    } else
      needs.push(
        inputNeed('deliveryPlan', 'Opening stock receipt must be confirmed manually', false),
      );
    return result(
      [...issues.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      needs,
      checks,
    );
  },
});
