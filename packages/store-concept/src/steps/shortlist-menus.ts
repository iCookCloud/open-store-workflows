import { MenuSlot, type Need, type StepDef, type Verification, z } from '@osw/core';
import { inspectDerives, mergeDerives } from '../derives.js';
import { assetRef, queryAll, result } from '../helpers.js';
import { ConceptDraft, MenuSelection } from '../models.js';

export const shortlistMenus: StepDef<typeof ConceptDraft, typeof MenuSelection> = {
  id: 'store-concept/shortlistMenus',
  input: ConceptDraft,
  output: MenuSelection,
  reads: ['menu'],
  params: [],
  approval: {
    question: 'Approve, adapt or drop this menu?',
    decision: z.enum(['approve', 'adapt', 'drop']),
  },
  async run(raw, ctx) {
    const concept = ConceptDraft.parse(raw);
    if (concept.template.data.nonFood)
      return result({
        concept,
        menu: { status: 'not-applicable', refs: [], approved: [] },
        downstream: mergeDerives([], true),
        sources: [],
        example: true,
      });
    const cuisine =
      concept.brief.cuisine ??
      (concept.template.data.cuisines.length === 1 ? concept.template.data.cuisines[0] : undefined);
    if (!cuisine)
      return result(
        {
          concept,
          menu: { status: 'none', refs: [], approved: [] },
          downstream: { coldchain: null, ingredients: [], equipment: [], sop: [] },
          sources: [],
          example: true,
        },
        [
          {
            kind: 'input',
            path: 'cuisine',
            reason: 'Select a cuisine to shortlist menus',
            blocking: false,
          },
        ],
      );
    const menus = await queryAll(ctx.assets, MenuSlot, {
      field: 'cuisine',
      op: 'eq',
      value: cuisine,
    });
    menus.sort(
      (a, b) =>
        Number(b.data.derives !== undefined) - Number(a.data.derives !== undefined) ||
        Number(b.data.origin === 'delivered') - Number(a.data.origin === 'delivered') ||
        (b.data.pageCount ?? 0) - (a.data.pageCount ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const refs = menus.map((record) => {
      const approvals = ctx.approvals
        .filter(
          (approval) =>
            approval.step === 'store-concept/shortlistMenus' &&
            approval.subject === `menu:${record.id}` &&
            approval.subjectHash === record.versionHash &&
            Date.parse(approval.at) <= Date.parse(ctx.now),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const approval = approvals[0];
      const status =
        approval?.decision === 'approve'
          ? ('approved' as const)
          : approval?.decision === 'adapt'
            ? ('adapting' as const)
            : approval?.decision === 'drop'
              ? ('dropped' as const)
              : ('candidate' as const);
      if (status === 'candidate' || status === 'adapting')
        needs.push({
          kind: 'approval',
          step: 'store-concept/shortlistMenus',
          subject: `menu:${record.id}`,
          subjectHash: record.versionHash,
          question:
            status === 'adapting'
              ? 'Approve the adapted menu or drop it'
              : 'Approve, adapt or drop this menu',
          blocking: false,
        });
      if (status === 'approved') {
        const inspected = inspectDerives(record.data.derives);
        if (!inspected.valid)
          verifications.push({
            asset: assetRef(record),
            purpose: 'store-concept/shortlistMenus',
            dimension: 'derives',
            verdict: inspected.missing ? 'pending' : 'fails',
            reason: inspected.missing
              ? 'Approved menu has no structured derivations'
              : 'Approved menu derivations are empty or invalid',
            at: ctx.now,
            by: ctx.actor,
          });
      }
      return { ref: assetRef(record), status, ...(approval?.note ? { note: approval.note } : {}) };
    });
    const approved = refs.filter((ref) => ref.status === 'approved').map((ref) => ref.ref);
    const selected = new Set(
      (approved.length
        ? refs.filter((ref) => ref.status === 'approved')
        : refs.filter((ref) => ref.status !== 'dropped')
      ).map((ref) => ref.ref.id),
    );
    if (!menus.length)
      needs.push({
        kind: 'asset',
        slot: 'menu',
        filter: { field: 'cuisine', op: 'eq', value: cuisine },
        reason: 'No menu is available for this cuisine',
        blocking: false,
      });
    const downstream = selected.size
      ? mergeDerives(
          menus.filter((menu) => selected.has(menu.id)).map((menu) => menu.data.derives),
          false,
        )
      : { coldchain: null, ingredients: [], equipment: [], sop: [] };
    return result(
      {
        concept,
        menu: {
          status: approved.length
            ? 'approved'
            : refs.some((ref) => ref.status !== 'dropped')
              ? 'candidate'
              : 'none',
          refs,
          approved,
        },
        downstream,
        sources: menus.map((menu) => assetRef(menu)),
        example: menus.every((menu) => menu.example === true),
      },
      needs,
      verifications,
    );
  },
};
