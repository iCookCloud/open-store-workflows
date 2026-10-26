import { defineSlot } from '@osw/core';
import { Reply, SegmentRuleset, SendLog, StoreContact, Suppression } from './models.js';

const eqin = ['eq', 'in'] as const;
export const segmentRulesetSlot = defineSlot({ name: 'segment-ruleset', schema: SegmentRuleset });
export const storeContactSlot = defineSlot({
  name: 'store-contact',
  schema: StoreContact,
  filterable: {
    storeId: eqin,
    channel: eqin,
    address: ['eq', 'in', 'contains'],
    verdict: eqin,
    source: eqin,
    optout: ['eq'],
  },
  sortable: ['createdAt', 'verifiedAt'],
});
export const suppressionSlot = defineSlot({
  name: 'suppression',
  schema: Suppression,
  filterable: { address: ['eq', 'in', 'contains'], reason: eqin, at: ['gte', 'lte'] },
  sortable: ['at'],
});
export const sendLogSlot = defineSlot({
  name: 'send-log',
  schema: SendLog,
  filterable: {
    campaignId: eqin,
    topicKey: eqin,
    variantKey: eqin,
    contactId: eqin,
    status: eqin,
    event: eqin,
    providerId: eqin,
    at: ['gte', 'lte'],
  },
  sortable: ['at', 'eventAt'],
});
export const replySlot = defineSlot({
  name: 'reply',
  schema: Reply,
  filterable: { sendId: eqin, contactId: eqin, kind: eqin, receivedAt: ['gte', 'lte'] },
  sortable: ['receivedAt'],
});
export const campaignSlots = [
  segmentRulesetSlot,
  storeContactSlot,
  suppressionSlot,
  sendLogSlot,
  replySlot,
];
