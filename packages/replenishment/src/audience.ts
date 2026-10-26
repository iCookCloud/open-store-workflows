import {
  type AssetRecordOf,
  Campaign,
  type Filter,
  type Need,
  OswSourceError,
  type Page,
  type SlotDef,
  type StepCtx,
  type StepDef,
  StoreSlot,
  z,
} from '@osw/core';
import { campaignContentHash } from './campaign.js';
import { classifyStores, segmentRegion } from './classify.js';
import { approvalNeed, blocked, numericParam, queryAll, result } from './helpers.js';
import { matchSuppliers } from './match.js';
import { SendIntent, type StoreContact } from './models.js';
import { matchRule, narrowerThan, normalizeRule, pickVariant, storeSubject } from './rule.js';
import { segmentRulesetSlot, sendLogSlot, storeContactSlot, suppressionSlot } from './slots.js';

export const AudienceInput = z.object({ campaign: Campaign, rulesetId: z.string().min(1) });
export const AudienceOutput = z.object({
  intents: z.array(SendIntent),
  funnel: z.object({
    total: z.number().int().nonnegative(),
    optout: z.number().int().nonnegative(),
    suppress: z.number().int().nonnegative(),
    typo: z.number().int().nonnegative(),
    issue: z.number().int().nonnegative(),
    topic: z.number().int().nonnegative(),
    recent: z.number().int().nonnegative(),
    variant: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    supplier: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
  }),
});
export const normalizeAddress = (address: string) => address.trim().toLowerCase();
async function visibleQuery<S extends z.ZodObject>(
  ctx: StepCtx,
  slot: SlotDef<S>,
  filter: Filter | null,
  limit: number,
  needs: Need[],
) {
  try {
    const records = await queryAll(ctx.assets, slot, filter, limit);
    if (!records.some((record) => record.redacted?.length)) return records;
  } catch (error) {
    if (!(error instanceof OswSourceError) || error.code !== 'field_forbidden') throw error;
  }
  needs.push({
    kind: 'asset',
    slot: slot.name,
    filter: null,
    reason: 'Audience selection requires visible asset fields',
    blocking: true,
  });
  return [];
}

const contactOrder = (a: AssetRecordOf<StoreContact>, b: AssetRecordOf<StoreContact>) => {
  const x = a.data.createdAt ?? a.data.verifiedAt ?? a.updatedAt;
  const y = b.data.createdAt ?? b.data.verifiedAt ?? b.updatedAt;
  return Date.parse(x) - Date.parse(y) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
export const selectAudience: StepDef<typeof AudienceInput, typeof AudienceOutput> = {
  id: 'replenishment/selectAudience',
  input: AudienceInput,
  output: AudienceOutput,
  reads: ['store', 'store-contact', 'suppression', 'send-log', 'segment-ruleset'],
  params: [
    { key: 'nl.runMax', required: true, description: 'Maximum audience query page' },
    { key: 'nl.capDays', required: true, description: 'Minimum gap between topics' },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const runMax = numericParam(ctx, 'nl.runMax', needs, { min: 1, max: 200, integer: true });
    const capDays = numericParam(ctx, 'nl.capDays', needs, { min: 0 });
    const hash = await campaignContentHash(input.campaign);
    const approval = approvalNeed(
      ctx,
      'replenishment/selectAudience',
      `campaign:${input.campaign.campaignId}`,
      hash,
      'send',
    );
    if (approval) needs.push(approval);
    if (input.campaign.contentHash !== hash)
      needs.push({
        kind: 'approval',
        step: 'replenishment/selectAudience',
        subject: `campaign:${input.campaign.campaignId}`,
        subjectHash: hash,
        question: 'Approve the current campaign content before selecting recipients',
        blocking: true,
      });
    const ruleset = await ctx.assets.get(segmentRulesetSlot, input.rulesetId);
    if (!ruleset)
      needs.push({
        kind: 'asset',
        slot: 'segment-ruleset',
        filter: null,
        reason: 'Segment ruleset not found',
        blocking: true,
      });
    if (!ruleset || runMax === null || capDays === null || needs.length) return blocked(needs);
    if (
      input.campaign.variants.some(
        (v) => !narrowerThan(v.rule, input.campaign.topicRule, ruleset.data),
      )
    )
      return blocked([
        {
          kind: 'input',
          path: 'campaign.variants',
          reason: 'Variant audience must narrow the topic rule',
          blocking: true,
        },
      ]);
    const classified = await classifyStores.run({ rulesetId: input.rulesetId }, ctx);
    if (!classified.output) return blocked(classified.needs, classified.verifications);
    const matched = await matchSuppliers.run({ segments: classified.output.segments }, ctx);
    if (!matched.output) return blocked(matched.needs, matched.verifications);
    const allowed = new Set(
      matched.output
        .find((m) => m.supplierId === input.campaign.supplierId)
        ?.segments.map((s) => s.key) ?? [],
    );
    const funnel = {
      total: 0,
      optout: 0,
      suppress: 0,
      typo: 0,
      issue: 0,
      topic: 0,
      recent: 0,
      variant: 0,
      duplicate: 0,
      supplier: 0,
      selected: 0,
    };
    // 状态与业态先下推；地区档可能重叠，逐条用前缀规则核验，避免大 in 列表截断。
    const filter: Filter = {
      all: [
        { field: 'status', op: 'eq', value: 'operating' },
        ...((normalizeRule(input.campaign.topicRule).tracks?.length ?? 0) > 0 &&
        (normalizeRule(input.campaign.topicRule).tracks?.length ?? 0) <= 200
          ? [
              {
                field: 'track',
                op: 'in',
                value: normalizeRule(input.campaign.topicRule).tracks!,
              } as Filter,
            ]
          : []),
      ],
    };
    let cursor: string | null = null;
    const seen = new Set<string>();
    const aliasOptouts = new Set<string>();
    const candidates: {
      contact: AssetRecordOf<StoreContact>;
      store: z.infer<typeof StoreSlot.schema>;
      storeId: string;
      logs: Awaited<ReturnType<typeof queryAll<typeof sendLogSlot.schema>>>;
      suppressions: Awaited<ReturnType<typeof queryAll<typeof suppressionSlot.schema>>>;
    }[] = [];
    do {
      const page: Page<z.infer<typeof StoreSlot.schema>> = await ctx.assets.query(
        StoreSlot,
        filter,
        { limit: runMax, cursor },
      );
      if (page.items.length) {
        const contacts = await visibleQuery(
          ctx,
          storeContactSlot,
          { field: 'storeId', op: 'in', value: page.items.map((s) => s.id) },
          runMax,
          needs,
        );
        if (needs.length) return blocked(needs);
        const addresses = [
          ...new Set(contacts.map((contact) => normalizeAddress(contact.data.address))),
        ];
        const addressSet = new Set(addresses);
        const aliases = new Map(contacts.map((contact) => [contact.id, contact]));
        const suppressions: Awaited<ReturnType<typeof queryAll<typeof suppressionSlot.schema>>> =
          [];
        // 联系人状态与历史以地址为边界；范围外的显式别名同样拥有退订和去重效力。
        const searchable = addresses.filter((address) => address.length >= 3);
        for (let offset = 0; offset < searchable.length; offset += 32) {
          const addressFilter: Filter = {
            any: searchable
              .slice(offset, offset + 32)
              .map((address) => ({ field: 'address', op: 'contains' as const, value: address })),
          };
          const found = await visibleQuery(ctx, storeContactSlot, addressFilter, runMax, needs);
          for (const alias of found)
            if (addressSet.has(normalizeAddress(alias.data.address))) aliases.set(alias.id, alias);
          suppressions.push(
            ...(await visibleQuery(ctx, suppressionSlot, addressFilter, runMax, needs)).filter(
              (entry) => addressSet.has(normalizeAddress(entry.data.address)),
            ),
          );
          if (needs.length) return blocked(needs);
        }
        const logs: Awaited<ReturnType<typeof queryAll<typeof sendLogSlot.schema>>> = [];
        const aliasIds = [...aliases.keys()];
        for (let offset = 0; offset < aliasIds.length; offset += 200) {
          logs.push(
            ...(await visibleQuery(
              ctx,
              sendLogSlot,
              { field: 'contactId', op: 'in', value: aliasIds.slice(offset, offset + 200) },
              runMax,
              needs,
            )),
          );
          if (needs.length) return blocked(needs);
        }
        for (const alias of aliases.values())
          if (alias.data.optout || alias.data.verdict === 'optout')
            aliasOptouts.add(normalizeAddress(alias.data.address));
        const aliasAddresses = new Map(
          [...aliases].map(([id, alias]) => [id, normalizeAddress(alias.data.address)]),
        );
        const stores = new Map(page.items.map((s) => [s.id, s]));
        for (const contact of contacts) {
          const store = stores.get(contact.data.storeId);
          if (store)
            candidates.push({
              contact,
              store: store.data,
              storeId: store.id,
              logs: logs.filter(
                (r) =>
                  aliasAddresses.get(r.data.contactId) === normalizeAddress(contact.data.address),
              ),
              suppressions: suppressions.filter(
                (r) => normalizeAddress(r.data.address) === normalizeAddress(contact.data.address),
              ),
            });
        }
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Repeated audience pagination cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    const optedOutAddresses = new Set([
      ...aliasOptouts,
      ...candidates
        .filter(
          (candidate) =>
            candidate.contact.data.optout ||
            candidate.contact.data.verdict === 'optout' ||
            candidate.suppressions.some((entry) => entry.data.reason === 'optout'),
        )
        .map((candidate) => normalizeAddress(candidate.contact.data.address)),
    ]);
    const logsByAddress = new Map<string, (typeof candidates)[number]['logs']>();
    for (const candidate of candidates) {
      const address = normalizeAddress(candidate.contact.data.address);
      logsByAddress.set(address, [...(logsByAddress.get(address) ?? []), ...candidate.logs]);
    }
    candidates.sort((a, b) => contactOrder(a.contact, b.contact));
    const claimed = new Set<string>();
    const intents: z.infer<typeof SendIntent>[] = [];
    const cutoff = Date.parse(ctx.now) - capDays * 86400000;
    for (const candidate of candidates) {
      funnel.total++;
      const { contact, store, storeId, suppressions } = candidate;
      const address = normalizeAddress(contact.data.address);
      // 同址先认最早建档者，再计每人的第一条排除原因。
      if (claimed.has(address)) {
        funnel.duplicate++;
        continue;
      }
      claimed.add(address);
      if (
        optedOutAddresses.has(address) ||
        contact.data.optout ||
        contact.data.verdict === 'optout' ||
        suppressions.some((s) => s.data.reason === 'optout')
      ) {
        funnel.optout++;
        continue;
      }
      if (suppressions.length) {
        funnel.suppress++;
        continue;
      }
      if (
        ['typo', 'invalid'].includes(contact.data.verdict) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
      ) {
        funnel.typo++;
        continue;
      }
      if (!['valid', 'verified'].includes(contact.data.verdict)) {
        funnel.issue++;
        continue;
      }
      const subject = storeSubject(store, ruleset.data, contact.data.categoryRaw);
      if (!matchRule(input.campaign.topicRule, subject, ruleset.data)) {
        funnel.topic++;
        continue;
      }
      if (!allowed.has(`${segmentRegion(store.jurisdiction, ruleset.data)}|${store.track}`)) {
        funnel.supplier++;
        continue;
      }
      const logs = logsByAddress.get(address) ?? [];
      if (
        logs.some(
          (log) =>
            (log.data.status === 'sent' || log.data.status === 'queued') &&
            (log.data.campaignId === input.campaign.campaignId ||
              log.data.topicKey === input.campaign.topicKey ||
              Date.parse(log.data.at) > cutoff),
        )
      ) {
        funnel.recent++;
        continue;
      }
      const variant = pickVariant(input.campaign.variants, subject, ruleset.data);
      if (!variant) {
        funnel.variant++;
        continue;
      }
      intents.push({ contactId: contact.id, storeId, variantKey: variant.variantKey });
      funnel.selected++;
    }
    return result({ intents, funnel });
  },
};
