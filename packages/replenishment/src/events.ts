import {
  IsoDateTime,
  type Need,
  type StepDef,
  type Verification,
  assetRef,
  getMany,
  z,
} from '@osw/core';
import { queryAll, result } from './helpers.js';
import { SendEvent } from './models.js';
import { advanceEvent } from './runner/ports.js';
import { replySlot, sendLogSlot, storeContactSlot } from './slots.js';

export const ProviderEventInput = z.object({
  providerId: z.string().min(1),
  event: z.enum(['delivered', 'soft_bounced', 'bounced', 'complained', 'opened', 'clicked']),
  at: IsoDateTime,
});
export const LedgerPatch = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    providerId: z.string().min(1),
    event: SendEvent,
    at: IsoDateTime,
  }),
  z.object({
    kind: z.literal('suppression'),
    contactId: z.string().min(1),
    reason: z.enum(['optout', 'bounce', 'complaint', 'invalid']),
    at: IsoDateTime,
  }),
]);
export type LedgerPatch = z.infer<typeof LedgerPatch>;
const Input = z.object({
  events: z.array(ProviderEventInput).max(200),
  replyIds: z.array(z.string().min(1)).max(200).optional(),
});
const Output = z.object({ patches: z.array(LedgerPatch) });

export const ingestEvents: StepDef<typeof Input, typeof Output> = {
  id: 'replenishment/ingestEvents',
  input: Input,
  output: Output,
  reads: ['send-log', 'reply', 'store-contact'],
  params: [],
  async run(input, ctx) {
    const needs: Need[] = [];
    const verifications: Verification[] = [];
    const patches: LedgerPatch[] = [];
    const providerIds = [...new Set(input.events.map((event) => event.providerId))];
    const logs = providerIds.length
      ? await queryAll(ctx.assets, sendLogSlot, {
          field: 'providerId',
          op: 'in',
          value: providerIds,
        })
      : [];
    const replies = await getMany(ctx.assets, replySlot, input.replyIds ?? []);
    const contactIds = [
      ...new Set([
        ...logs.map((log) => log.data.contactId),
        ...replies.map((reply) => reply.data.contactId),
      ]),
    ];
    const contacts = await getMany(ctx.assets, storeContactSlot, contactIds);
    const byContact = new Map(contacts.map((contact) => [contact.id, contact]));
    const current = new Map(logs.map((log) => [log.id, log.data.event]));
    for (const event of input.events) {
      const log = logs.find((row) => row.data.providerId === event.providerId);
      if (!log) {
        needs.push({
          kind: 'action',
          action: 'linkProviderEvent',
          ref: event.providerId,
          reason:
            'Provider event has no matching send reservation yet; retry after the send report is visible',
          blocking: true,
        });
        continue;
      }
      const previous = current.get(log.id) ?? log.data.event;
      const next = advanceEvent(previous, event.event);
      if (next !== previous) {
        patches.push({ kind: 'event', providerId: event.providerId, event: next, at: event.at });
        current.set(log.id, next);
      }
      if (event.event === 'bounced' || event.event === 'complained') {
        patches.push({
          kind: 'suppression',
          contactId: log.data.contactId,
          reason: event.event === 'bounced' ? 'bounce' : 'complaint',
          at: event.at,
        });
        const contact = byContact.get(log.data.contactId);
        if (contact)
          verifications.push({
            asset: assetRef(contact),
            purpose: 'replenishment/ingestEvents',
            dimension: 'deliverability',
            verdict: 'fails',
            reason: 'Provider reported a permanent delivery problem',
            evidence: [log.id, event.event],
            at: ctx.now,
            by: ctx.actor,
          });
      }
    }
    for (const reply of replies) {
      const contact = byContact.get(reply.data.contactId);
      if (reply.data.kind === 'unsubscribe') {
        patches.push({
          kind: 'suppression',
          contactId: reply.data.contactId,
          reason: 'optout',
          at: reply.data.receivedAt,
        });
        if (reply.data.sendId) {
          const log = await ctx.assets.get(sendLogSlot, reply.data.sendId);
          if (log?.data.providerId && advanceEvent(log.data.event, 'unsub') === 'unsub')
            patches.push({
              kind: 'event',
              providerId: log.data.providerId,
              event: 'unsub',
              at: reply.data.receivedAt,
            });
        }
      }
      if (reply.data.kind === 'closed' && contact)
        verifications.push({
          asset: assetRef(contact),
          purpose: 'replenishment/ingestEvents',
          dimension: 'deliverability',
          verdict: 'pending',
          reason:
            'Human-classified reply reports a closed store; the asset owner must confirm store status',
          evidence: [reply.id],
          at: ctx.now,
          by: ctx.actor,
        });
    }
    return result({ patches }, needs, verifications);
  },
};
