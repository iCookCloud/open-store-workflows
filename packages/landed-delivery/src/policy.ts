import type { Need, StepCtx, z } from '@osw/core';
import { deliveryStep, inputNeed, stepResult } from './helpers.js';
import { type PartyEdit, Shipment } from './models.js';
import { cellFields, conflicts } from './packing/fill.js';

const headerFields = [
  'consignee.jurisdiction',
  'consignee.company',
  'consignee.address',
  'consignee.name',
  'consignee.phone',
  'consignee.email',
  'portTo',
] as const;
const trackingFields = [
  'tracking.blNo',
  'tracking.containerNo',
  'tracking.etd',
  'tracking.eta',
] as const;
const operatorLineFields = ['name', 'spec', 'qty', 'declaredValue'] as const;
const empty = (value: unknown) => value === undefined || value === null || value === '';
export function editShipment(
  original: Shipment,
  edits: z.infer<typeof PartyEdit>[],
  ctx: Pick<StepCtx, 'now' | 'actor'>,
) {
  const shipment = structuredClone(original);
  const needs: Need[] = [];
  for (const edit of edits) {
    const operator = edit.role === 'operator';
    const line = edit.lineId ? shipment.lines.find((line) => line.id === edit.lineId) : undefined;
    if (edit.role === 'client') {
      needs.push(
        inputNeed(
          'edits',
          'Client decisions use assignCarrier or collectQuotes approval; arbitrary field edits are prohibited',
        ),
      );
      continue;
    }
    if (
      (edit.role === 'forwarder' && shipment.carrier.kind !== 'forwarder') ||
      (edit.role === 'own' && shipment.carrier.kind !== 'own')
    ) {
      needs.push(inputNeed('edits.role', 'Editing role does not match the assigned carrier'));
      continue;
    }
    const isCell = cellFields.some((field) => field === edit.field);
    const allowed = edit.lineId
      ? Boolean(line) &&
        (isCell ||
          (operator && operatorLineFields.some((field) => field === edit.field)) ||
          edit.field === 'qty')
      : headerFields.some((field) => field === edit.field) ||
        trackingFields.some((field) => field === edit.field) ||
        (operator && ['portFrom', 'documents'].includes(edit.field));
    if (!allowed) {
      needs.push(
        inputNeed(
          `edits.${edit.field}`,
          'Field is not editable by this role; state and node changes use trackShipment',
        ),
      );
      continue;
    }
    const parts = edit.field.split('.');
    const holder = (line ??
      (parts.length === 2
        ? shipment[parts[0] as 'consignee' | 'tracking']
        : shipment)) as unknown as Record<string, unknown>;
    const field = parts.at(-1)!;
    const before = holder[field];
    const beforeValue = isCell && line ? (before as { value: unknown }).value : before;
    if (JSON.stringify(beforeValue) === JSON.stringify(edit.value)) continue;
    if (!operator && !empty(beforeValue)) {
      needs.push(inputNeed(`edits.${edit.field}`, 'Carrier may fill empty fields only'));
      continue;
    }
    if (shipment.status !== 'draft' && !edit.reason?.trim()) {
      needs.push(
        inputNeed('edits.reason', 'Changes after confirmation require an amendment reason'),
      );
      continue;
    }
    const after =
      isCell && line
        ? {
            value: structuredClone(edit.value),
            src: 'manual',
            by: operator ? 'operator' : 'forwarder',
          }
        : structuredClone(edit.value);
    holder[field] = after;
    if (shipment.status !== 'draft')
      shipment.amendments.push({
        field: edit.field,
        lineId: edit.lineId ?? null,
        before,
        after,
        reason: edit.reason!,
        by: ctx.actor,
        at: ctx.now,
      });
  }
  const parsed = Shipment.safeParse(shipment);
  if (!parsed.success)
    needs.push(
      ...parsed.error.issues.map((issue) => inputNeed(issue.path.join('.'), issue.message)),
    );
  else {
    needs.push(...conflicts(parsed.data).map((reason) => inputNeed('shipment', reason)));
    if (
      shipment.documents.length !== original.documents.length ||
      shipment.documents.some((document) => {
        const prior = original.documents.find((item) => item.itemRootId === document.itemRootId);
        return (
          !prior ||
          JSON.stringify(document.productRefs) !== JSON.stringify(prior.productRefs) ||
          (document.state === 'cited' && document.evidence.length === 0)
        );
      })
    )
      needs.push(
        inputNeed(
          'documents',
          'Keep the required batch-document identities and attach evidence to cited documents',
        ),
      );
  }
  return { shipment: needs.length ? original : shipment, needs };
}
export const applyPartyEdits = deliveryStep('applyPartyEdits', [], async (state, ctx) => {
  const needs: Need[] = [];
  for (const [id, edits] of Object.entries(state.input.edits)) {
    const index = state.plan.shipments.findIndex((shipment) => shipment.id === id);
    if (index === -1) {
      needs.push(inputNeed('edits', 'Unknown shipment ID'));
      continue;
    }
    const edited = editShipment(state.plan.shipments[index], edits, ctx);
    needs.push(...edited.needs);
    state.plan.shipments[index] = edited.shipment;
  }
  return stepResult(state, needs);
});
export function viewFor(shipment: Shipment, role: 'operator' | 'client' | 'forwarder' | 'own') {
  if (role === 'operator') return structuredClone(shipment);
  const carrier = shipment.carrier;
  const {
    quotes,
    amendments: _amendments,
    holds: _holds,
    arrival,
    ...visible
  } = structuredClone(shipment);
  return {
    ...visible,
    quotes:
      role === 'client'
        ? quotes.filter((quote) => quote.id === shipment.chosenQuoteId)
        : carrier.kind === 'forwarder'
          ? quotes.filter((quote) => quote.partyRef.id === carrier.partyRef.id)
          : [],
    arrival: arrival
      ? { ...arrival, lines: arrival.lines.map(({ note: _note, ...line }) => line) }
      : null,
  };
}
