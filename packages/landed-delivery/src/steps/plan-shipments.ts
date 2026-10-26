import {
  type Need,
  OfferSlot,
  PartySlot,
  ProductSlot,
  StoreSlot,
  assetRef,
  getMany,
  versionHash,
} from '@osw/core';
import {
  actionNeed,
  assetNeed,
  deliveryStep,
  inputNeed,
  loadFx,
  queryIn,
  refMatches,
  stepResult,
} from '../helpers.js';
import type { Shipment } from '../models.js';
import { fillEmptyCells, packingLine } from '../packing/fill.js';
import { classifyGoods } from '../packing/goods-class.js';
import { declarationValue, parseCartonUnits, pieceQuantity } from '../packing/units.js';
import { packingHistorySlot } from '../slots.js';

export const planShipments = deliveryStep(
  'planShipments',
  ['product', 'offer', 'party', 'store', 'packing-history', 'params'],
  async (state, ctx) => {
    const { input, plan } = state;
    const needs: Need[] = [];
    const store = (
      await getMany(ctx.assets, StoreSlot, input.bom.storeId ? [input.bom.storeId] : [])
    )[0];
    if (!store || store.data.jurisdiction !== input.jurisdiction || store.data.status === 'closed')
      return stepResult(state, [
        assetNeed(
          'store',
          'A preparing or operating store in the requested jurisdiction is required',
        ),
      ]);
    const products = await getMany(
      ctx.assets,
      ProductSlot,
      input.bom.body.lines.flatMap((line) => (line.productRef ? [line.productRef.id] : [])),
    );
    const offers = await getMany(
      ctx.assets,
      OfferSlot,
      input.bom.body.lines.flatMap((line) => (line.offerRef ? [line.offerRef.id] : [])),
    );
    const parties = await getMany(
      ctx.assets,
      PartySlot,
      offers.map((offer) => offer.data.partyId),
    );
    const histories = await queryIn(
      ctx.assets,
      packingHistorySlot,
      'productId',
      products.map((product) => product.id),
    );
    const currency = ctx.params.get('customs.declarationCurrency', {
      jurisdiction: input.jurisdiction,
    });
    if (!currency)
      return stepResult(state, [
        ctx.params.need?.('customs.declarationCurrency', { jurisdiction: input.jurisdiction }) ?? {
          kind: 'param',
          key: 'customs.declarationCurrency',
          reason: 'missing',
          blocking: true,
        },
      ]);
    if (typeof currency.value !== 'string' || !/^[A-Z]{3}$/.test(currency.value))
      return stepResult(state, [
        inputNeed('params.customs.declarationCurrency', 'Expected a currency code'),
      ]);
    const fxCtx = await loadFx(
      ctx,
      input.bom.body.lines
        .filter((line) => line.unitPrice.currency !== currency.value)
        .map((line) => `fx.${line.unitPrice.currency}.${currency.value}`),
      input.jurisdiction,
    );
    const loading = input.site?.body.conditions.find(
      (condition) => condition.key === 'loadingAccess',
    );
    const observed =
      loading?.measure.basis === 'observed' &&
      !input.site?.body.unmeasured.some((requirement) => requirement.key === 'loadingAccess') &&
      (!loading.measure.expiresAt || loading.measure.expiresAt >= ctx.now.slice(0, 10));
    const hasDock =
      observed && ['dock', 'loading_dock', '有装卸平台'].includes(String(loading.measure.value));
    if (!observed)
      needs.push(
        inputNeed(
          'SiteDecision.conditions[loadingAccess]',
          'Loading access has not been measured; request liftgate service',
          false,
        ),
      );
    const represented = new Set(
      plan.shipments.flatMap((shipment) => shipment.lines.map((line) => line.bomLineId)),
    );
    for (const shipment of plan.shipments)
      for (const line of shipment.lines) {
        if (!input.bom.body.lines.some((bomLine) => bomLine.id === line.bomLineId))
          needs.push(
            inputNeed(
              'existing.shipments',
              'Existing shipment references a removed BOM line; reconcile explicitly',
            ),
          );
        if (plan.held.some((held) => held.bomLineId === line.bomLineId))
          needs.push(
            inputNeed(
              'existing.shipments',
              'Existing shipment contains a line whose current admission is held',
            ),
          );
      }
    for (const line of input.bom.body.lines) {
      if (plan.held.some((held) => held.bomLineId === line.id)) continue;
      const product = products.find((record) => record.id === line.productRef?.id);
      const offer = offers.find((record) => record.id === line.offerRef?.id);
      if (
        !product ||
        !offer ||
        !line.productRef ||
        !line.offerRef ||
        !refMatches(line.productRef, product) ||
        !refMatches(line.offerRef, offer) ||
        !plan.compliance.some(
          (entry) =>
            entry.productRef.id === product.id &&
            entry.productRef.versionHash === product.versionHash &&
            entry.conclusion === 'enter',
        )
      ) {
        needs.push(
          inputNeed(
            `bom.lines.${line.id}`,
            'Current product, offer and admission decision must agree',
          ),
        );
        continue;
      }
      const party = parties.find((record) => record.id === offer.data.partyId);
      const origin = (offer.data.shipFrom ?? party?.data.base?.jurisdiction)?.split('-')[0];
      if (!origin) {
        needs.push(assetNeed('party', `${line.id}: offer and supplier have no shipping origin`));
        continue;
      }
      const crossBorder = origin !== plan.market;
      const mode = !crossBorder
        ? 'ground'
        : line.urgent
          ? 'air'
          : store.data.status === 'preparing'
            ? 'sea_fcl'
            : 'sea_lcl';
      const goods = classifyGoods(product.data, line.category, line.name);
      if (goods.src === 'derived')
        needs.push(
          actionNeed(
            'confirmGoodsClass',
            'Goods class inferred from words; confirm before packing',
            line.id,
          ),
        );
      const qty = pieceQuantity(
        line.qty,
        line.unit,
        product.data.carton?.units ?? parseCartonUnits(product.data.spec ?? line.spec),
      );
      if (qty === null) {
        plan.held.push({
          bomLineId: line.id,
          reason: 'unit_unconvertible',
          detail: 'Unit cannot be converted to pieces without carton information',
        });
        needs.push(inputNeed(`bom.lines.${line.id}.unit`, 'Unsupported piece conversion', false));
        continue;
      }
      const declared = declarationValue(
        line.unitPrice,
        line.qty,
        currency.value,
        input.jurisdiction,
        fxCtx,
        needs,
      );
      if (!declared) {
        plan.held.push({
          bomLineId: line.id,
          reason: 'fx_unverified',
          detail: 'Declaration currency conversion is unverified',
        });
        continue;
      }
      const fresh = packingLine(
        line,
        product.data,
        qty,
        declared,
        histories.filter(
          (record) => record.data.productId === product.id && record.data.confirmedAt <= ctx.now,
        ),
      );
      const seller = offer.data.delivery === 'seller_delivers';
      const groupMatches = (shipment: Shipment) =>
        shipment.origin === origin &&
        shipment.goodsClass === goods.goodsClass &&
        shipment.mode === mode &&
        (seller
          ? shipment.carrier.kind === 'seller' &&
            shipment.carrier.partyRef.id === offer.data.partyId
          : shipment.carrier.kind !== 'seller');
      if (represented.has(line.id)) {
        const owners = plan.shipments.filter((shipment) =>
          shipment.lines.some((existing) => existing.bomLineId === line.id),
        );
        if (
          owners.some(
            (shipment) =>
              !groupMatches(shipment) ||
              shipment.lines.some(
                (existing) =>
                  existing.bomLineId === line.id &&
                  (existing.productRef?.versionHash !== fresh.productRef?.versionHash ||
                    existing.offerRef.versionHash !== fresh.offerRef.versionHash),
              ),
          )
        ) {
          plan.held.push({
            bomLineId: line.id,
            reason: 'goods_mismatch',
            detail: 'Existing shipment group or selected asset changed',
          });
          needs.push(
            inputNeed(
              'existing.shipments',
              'Reconcile changed shipment grouping or selected assets',
            ),
          );
          continue;
        }
        for (const shipment of owners)
          if (shipment.status === 'draft')
            for (const existing of shipment.lines.filter(
              (candidate) => candidate.bomLineId === line.id,
            ))
              fillEmptyCells(existing, fresh);
        continue;
      }
      let shipment = plan.shipments.find(
        (candidate) => candidate.status === 'draft' && groupMatches(candidate),
      );
      if (!shipment) {
        const key = {
          origin,
          goodsClass: goods.goodsClass,
          mode,
          seller: seller ? offer.data.partyId : null,
        };
        const prefix = `shipment-${(await versionHash(key)).slice(0, 16)}`;
        let sequence = 1;
        while (plan.shipments.some((candidate) => candidate.id === `${prefix}-${sequence}`))
          sequence++;
        const address = input.site?.body.address ?? store.data.address;
        shipment = {
          id: `${prefix}-${sequence}`,
          origin,
          goodsClass: goods.goodsClass,
          mode,
          crossBorder,
          status: 'draft',
          node: null,
          consignee: {
            jurisdiction: input.jurisdiction,
            ...(address
              ? {
                  address: [address.line1, address.line2, address.locality, address.postalCode]
                    .filter(Boolean)
                    .join(', '),
                }
              : {}),
            ...input.consignee,
          },
          portFrom: null,
          portTo: input.portTo ?? null,
          lastMile: hasDock
            ? []
            : mode === 'ground' || mode === 'air'
              ? ['liftgate']
              : ['liftgate', 'small_vehicle'],
          carrier:
            seller && party
              ? { kind: 'seller', partyRef: assetRef(party) }
              : { kind: 'unassigned' },
          lines: [],
          quotes: [],
          chosenQuoteId: null,
          freight: null,
          documents: [],
          tracking: {},
          holds: [],
          arrival: null,
          amendments: [],
        };
        if (seller && !party) {
          needs.push(assetNeed('party', `Missing seller ${offer.data.partyId}`));
          continue;
        }
        plan.shipments.push(shipment);
      }
      shipment.lines.push(fresh);
      represented.add(line.id);
      const entry = plan.compliance.find((entry) => entry.productRef.id === product.id)!;
      for (const item of entry.items.filter((item) => item.level === 'batch')) {
        let document = shipment.documents.find(
          (document) => document.itemRootId === item.itemRootId,
        );
        if (!document) {
          document = {
            itemRootId: item.itemRootId,
            productRefs: [],
            state: 'unanswered',
            evidence: [],
          };
          shipment.documents.push(document);
        }
        if (!document.productRefs.some((ref) => ref.id === product.id))
          document.productRefs.push(assetRef(product));
      }
    }
    return stepResult(state, needs);
  },
);
