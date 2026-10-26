import {
  type AssetRecordOf,
  type Need,
  OfferSlot,
  PartySlot,
  ProductSlot,
  type Verification,
  assetRef,
  getMany,
  versionHash,
} from '@osw/core';
import { resolveCategories } from '../compliance/resolve.js';
import {
  actionNeed,
  approval,
  assetNeed,
  deliveryStep,
  inputNeed,
  queryIn,
  refMatches,
  stepResult,
  validateArtifact,
  verification,
} from '../helpers.js';
import type { ComplianceEntry } from '../models.js';
import { complianceAnswerSlot, productClassificationSlot } from '../slots.js';

export const screenCompliance = deliveryStep(
  'screenCompliance',
  [
    'product',
    'offer',
    'party',
    'compliance-category',
    'compliance-item',
    'product-classification',
    'compliance-answer',
  ],
  async (state, ctx) => {
    const { input, plan } = state;
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    if (new Set(plan.shipments.map((shipment) => shipment.id)).size !== plan.shipments.length)
      needs.push(inputNeed('existing.shipments', 'Shipment IDs must be unique'));
    for (const artifact of [input.bom, input.site, input.existing])
      if (artifact) await validateArtifact(artifact, needs);
    if (new Set(input.bom.body.lines.map((line) => line.id)).size !== input.bom.body.lines.length)
      needs.push(inputNeed('bom.body.lines', 'BOM line IDs must be unique'));
    if (
      input.site &&
      (input.site.storeId !== input.bom.storeId ||
        input.site.body.jurisdiction !== input.jurisdiction)
    )
      needs.push(inputNeed('site', 'Site and BOM must refer to the same store and jurisdiction'));
    if (
      input.existing &&
      (input.existing.storeId !== input.bom.storeId ||
        input.existing.body.market !== plan.market ||
        input.existing.id !== input.id)
    )
      needs.push(inputNeed('existing', 'Existing plan identity, store or market differs'));
    const offers = await getMany(
      ctx.assets,
      OfferSlot,
      input.bom.body.lines.flatMap((line) => (line.offerRef ? [line.offerRef.id] : [])),
    );
    const products = await getMany(
      ctx.assets,
      ProductSlot,
      input.bom.body.lines.flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
    );
    const eligible = input.bom.body.lines.filter((line) => {
      if (!line.offerRef) {
        plan.held.push({
          bomLineId: line.id,
          reason: 'no_offer',
          detail: 'Select an offer before shipment planning',
        });
        needs.push(inputNeed(`bom.lines.${line.id}.offerRef`, 'No selected offer', false));
        return false;
      }
      const offer = offers.find((record) => record.id === line.offerRef!.id);
      const product = products.find((record) => record.id === line.productRef?.id);
      if (
        !offer ||
        !refMatches(line.offerRef, offer) ||
        !product ||
        !line.productRef ||
        !refMatches(line.productRef, product) ||
        offer.data.productId !== product.id
      ) {
        plan.held.push({
          bomLineId: line.id,
          reason: 'compliance_pending',
          detail: 'Missing, changed or mismatched product/offer',
        });
        needs.push(
          assetNeed('product', 'Refresh the selected product and offer references', false),
        );
        return false;
      }
      return true;
    });
    const productIds = [...new Set(eligible.map((line) => line.productRef!.id))];
    const marketFilter = { field: 'market', op: 'eq' as const, value: plan.market };
    const classifications = await queryIn(
      ctx.assets,
      productClassificationSlot,
      'productId',
      productIds,
      marketFilter,
    );
    const resolved = await resolveCategories(
      classifications.map((record) => record.data.categoryId),
      plan.market,
      input.jurisdiction,
      ctx,
    );
    const roots = [
      ...new Set(
        [...resolved.values()].flatMap((category) => category.items.map((item) => item.rootId)),
      ),
    ];
    const answers = await queryIn(
      ctx.assets,
      complianceAnswerSlot,
      'itemRootId',
      roots,
      marketFilter,
    );
    const parties = await getMany(ctx.assets, PartySlot, [
      ...offers.map((record) => record.data.partyId),
      ...(input.importerRef ? [input.importerRef.id] : []),
      ...ctx.approvals.flatMap((a) => (a.role === 'lawyer' && a.party ? [a.party.id] : [])),
    ]);
    const until = [
      ctx.now.slice(0, 10),
      input.expectedArrival ?? '',
      ...plan.shipments.map((shipment) => shipment.tracking.eta ?? ''),
    ]
      .sort()
      .at(-1)!;
    for (const productId of productIds) {
      const product = products.find((record) => record.id === productId)!;
      const matches = classifications.filter(
        (record) => record.data.productId === productId && record.data.at <= ctx.now,
      );
      const categoryId = matches.length === 1 ? matches[0].data.categoryId : null;
      const category = categoryId ? resolved.get(categoryId) : undefined;
      const entry: ComplianceEntry = {
        productRef: assetRef(product),
        market: plan.market,
        categoryId,
        tree: category?.tree ?? 'unclassified',
        items: [],
        open: { mandatory: 0, advisory: 0 },
        orphans: category?.orphans ?? [],
        subjectHash: '0'.repeat(64),
        conclusion: 'undecided',
      };
      const suppliers = [
        ...new Set(
          eligible
            .filter((line) => line.productRef!.id === productId)
            .map((line) => offers.find((record) => record.id === line.offerRef!.id)!.data.partyId),
        ),
      ];
      const usedAnswers: AssetRecordOf<unknown>[] = [];
      for (const item of category?.items ?? []) {
        const rule = item.record.data;
        let answerState: ComplianceEntry['items'][number]['state'] = 'unanswered';
        const evidence: string[] = [];
        if (rule.level !== 'batch') {
          const subjects =
            rule.level === 'sku'
              ? [{ kind: 'product', id: productId }]
              : rule.entityRole === 'supplier'
                ? suppliers.map((id) => ({ kind: 'party', id }))
                : rule.entityRole === 'importer' &&
                    input.importerRef &&
                    parties.some((record) => refMatches(input.importerRef!, record))
                  ? [{ kind: 'party', id: input.importerRef.id }]
                  : [];
          const states = subjects.map((subject) => {
            if (subject.kind === 'party' && !parties.some((party) => party.id === subject.id))
              return 'unanswered' as const;
            const candidates = answers
              .filter(
                (record) =>
                  record.data.itemRootId === item.rootId &&
                  record.data.subject.kind === subject.kind &&
                  record.data.subject.id === subject.id &&
                  record.data.at <= ctx.now,
              )
              .sort((a, b) => (a.data.at > b.data.at ? -1 : a.data.at < b.data.at ? 1 : 0));
            const answer = candidates[0];
            if (!answer || candidates[1]?.data.at === answer.data.at) return 'unanswered' as const;
            usedAnswers.push(answer);
            evidence.push(...answer.data.evidence);
            if (answer.data.validUntil && answer.data.validUntil < until) return 'expired' as const;
            return answer.data.state === 'cited' && !answer.data.evidence.length
              ? ('unanswered' as const)
              : answer.data.state;
          });
          answerState = !states.length
            ? 'unanswered'
            : (states.find((value) => value !== 'cited') ?? 'cited');
          if (answerState !== 'cited') entry.open[rule.required]++;
        }
        entry.items.push({
          itemRootId: item.rootId,
          level: rule.level,
          required: rule.required,
          state: answerState,
          evidence: [...new Set(evidence)].sort(),
        });
      }
      const { subjectHash: ignoredHash, conclusion: ignoredConclusion, ...review } = entry;
      // 哈希字段本身不参与摘要；同时绑定证据版本、主体和有效期，答复更新必须重批。
      entry.subjectHash = await versionHash({
        entry: review,
        jurisdiction: input.jurisdiction,
        until,
        suppliers,
        importer: input.importerRef ?? null,
        sources: [
          ...matches,
          ...(category?.sources ?? []),
          ...(category?.itemSources ?? []),
          ...usedAnswers,
        ].map((record) => assetRef(record)),
      });
      if (entry.tree !== 'ok' || entry.orphans.length)
        needs.push(
          assetNeed(
            'compliance-category',
            `${productId}: ${entry.tree}; unresolved overrides: ${entry.orphans.join(',')}`,
            false,
          ),
        );
      else {
        const decision = approval(
          ctx,
          'screenCompliance',
          `product:${productId}@${plan.market}`,
          entry.subjectHash,
          ['reviewer', 'lawyer'],
          ['enter', 'special_review', 'deny', 'undecided'],
          needs,
        );
        if (
          decision?.role === 'lawyer' &&
          (!decision.party ||
            !parties.some(
              (record) =>
                refMatches(decision.party!, record) &&
                record.data.roles.includes('lawyer') &&
                record.data.status !== 'retired',
            ))
        )
          needs.push(
            inputNeed(
              'approvals.party',
              'Lawyer approval requires a current lawyer party reference',
            ),
          );
        else if (decision?.decision === 'enter' && entry.open.mandatory > 0)
          needs.push(
            actionNeed(
              'resolveCompliance',
              'Mandatory evidence remains unresolved',
              productId,
              true,
            ),
          );
        else if (decision) entry.conclusion = decision.decision as ComplianceEntry['conclusion'];
      }
      if (entry.conclusion !== 'enter')
        for (const line of eligible.filter((line) => line.productRef!.id === productId)) {
          plan.held.push({
            bomLineId: line.id,
            reason: entry.conclusion === 'deny' ? 'compliance_deny' : 'compliance_pending',
            detail: `${entry.tree}: ${entry.conclusion}`,
          });
          if (entry.conclusion === 'deny')
            needs.push(actionNeed('replaceProduct', 'Product admission was denied', line.id));
        }
      verifications.push(
        verification(
          ctx,
          'screenCompliance',
          entry.productRef,
          'access',
          entry.conclusion === 'enter'
            ? 'holds'
            : entry.conclusion === 'deny'
              ? 'fails'
              : 'pending',
          `Human decision: ${entry.conclusion}; tree: ${entry.tree}`,
          undefined,
          entry.items.flatMap((item) => item.evidence),
        ),
      );
      plan.compliance.push(entry);
    }
    return stepResult(state, needs, verifications);
  },
  true,
);
