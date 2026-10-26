import {
  Campaign,
  type Need,
  type StepCtx,
  type StepResult,
  StoreSlot,
  TemplateSlot,
  z,
} from '@osw/core';
import { selectAudience } from '../audience.js';
import { campaignContentHash, lintNewsletterBody } from '../campaign.js';
import { type LedgerPatch, ingestEvents } from '../events.js';
import { blocked, numericParam, result } from '../helpers.js';
import { storeContactSlot } from '../slots.js';
import { decideSend } from '../throttle.js';
import type {
  MailMessage,
  MailProvider,
  MailSendResult,
  SupplyLedger,
  WebhookRequest,
} from './ports.js';
import { createUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe.js';

type CampaignData = z.infer<typeof Campaign>;
export interface CampaignSendOptions {
  provider: MailProvider;
  ledger: SupplyLedger;
  from: string;
  replyTo?: string;
  unsubscribeBaseUrl: string;
  unsubscribeSecret: string;
  webhookSecret?: string;
  domainBreakerFrom?: string;
  storeUrl: (storeId: string) => string;
  sleep?: (milliseconds: number) => Promise<void>;
}
export interface SendExecution {
  reserved: number;
  sent: number;
  failed: number;
  skipped: number;
  decision: string;
  domainBreakerFrom?: string;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function fill(text: string, values: Record<string, string>, html: boolean): string {
  return text.replace(/\{\{(UNSUB|STORE|STORE_URL)\}\}/g, (_, key: string) =>
    html ? escapeHtml(values[key]) : values[key],
  );
}
function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Mail links must use HTTPS without credentials');
  return url.toString();
}
async function blocksFor(campaign: CampaignData, ctx: StepCtx) {
  const contents = new Map<string, { html: string; text: string }>();
  for (const ref of [
    ...campaign.sharedBlocks,
    ...campaign.variants.flatMap((variant) => [variant.lead, variant.service]),
  ]) {
    const record = ref.slot === 'template' ? await ctx.assets.get(TemplateSlot, ref.id) : null;
    if (
      !record ||
      record.versionHash !== ref.versionHash ||
      record.redacted?.length ||
      record.data.kind !== 'newsletter-block'
    )
      throw new Error('An approved newsletter block is missing or has changed');
    if (record.data.format === 'json') {
      const body = z
        .object({ html: z.string().min(1), text: z.string().min(1) })
        .parse(record.data.content);
      contents.set(ref.id, body);
    } else {
      const text = z.string().min(1).parse(record.data.body);
      contents.set(ref.id, { text, html: `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>` });
    }
  }
  for (const variant of campaign.variants) {
    const refs = [variant.lead, variant.service, ...campaign.sharedBlocks];
    const html = refs.map((ref) => contents.get(ref.id)!.html).join('\n');
    const text = refs.map((ref) => contents.get(ref.id)!.text).join('\n\n');
    if (lintNewsletterBody(html).length || lintNewsletterBody(text).length)
      throw new Error('Newsletter bodies violate the approved placeholder rules');
  }
  return contents;
}

export async function runCampaignSend(
  input: { campaign: CampaignData; rulesetId: string },
  ctx: StepCtx,
  options: CampaignSendOptions,
): Promise<StepResult<SendExecution>> {
  const campaign = Campaign.parse(input.campaign);
  const checked = await selectAudience.run({ campaign, rulesetId: input.rulesetId }, ctx);
  if (!checked.output) return blocked(checked.needs, checked.verifications);
  const decision = await decideSend.run(
    {
      campaign,
      webhookReady: Boolean(options.webhookSecret && options.provider.caps.events),
      ...(options.domainBreakerFrom ? { domainBreakerFrom: options.domainBreakerFrom } : {}),
    },
    ctx,
  );
  if (!decision.output)
    return blocked(decision.needs, [...checked.verifications, ...decision.verifications]);
  const needs: Need[] = [...checked.needs, ...decision.needs];
  const stats: SendExecution = {
    reserved: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    decision: decision.output.decision,
    ...(decision.output.domainBreakerFrom
      ? { domainBreakerFrom: decision.output.domainBreakerFrom }
      : {}),
  };
  if (decision.output.decision !== 'send') return result(stats, needs);
  const interval = numericParam(ctx, 'nl.provider.minIntervalMs', needs, { min: 0, integer: true });
  if (interval === null) return blocked(needs);
  if ((await campaignContentHash(campaign)) !== campaign.contentHash)
    return blocked([
      {
        kind: 'action',
        action: 'reapproveCampaign',
        ref: campaign.campaignId,
        reason: 'Campaign content changed after approval',
        blocking: true,
      },
    ]);
  if (
    !options.from.trim() ||
    !options.unsubscribeSecret ||
    /[\r\n]/.test(options.from + (options.replyTo ?? ''))
  )
    return blocked([
      {
        kind: 'input',
        path: 'mailConfiguration',
        reason: 'Sender configuration and unsubscribe secret are required',
        blocking: true,
      },
    ]);
  const contents = await blocksFor(campaign, ctx);
  const unsubscribeBaseUrl = safeUrl(options.unsubscribeBaseUrl);
  const prepared: {
    intent: (typeof checked.output.intents)[number];
    message: Omit<MailMessage, 'idempotencyKey'>;
  }[] = [];
  for (const intent of checked.output.intents.slice(0, decision.output.count)) {
    const contact = await ctx.assets.get(storeContactSlot, intent.contactId);
    const store = await ctx.assets.get(StoreSlot, intent.storeId);
    if (
      !contact ||
      contact.data.storeId !== intent.storeId ||
      !store ||
      store.data.status !== 'operating' ||
      contact.data.optout ||
      !['valid', 'verified'].includes(contact.data.verdict) ||
      contact.redacted?.length
    ) {
      stats.skipped++;
      continue;
    }
    const variant = campaign.variants.find(
      (candidate) => candidate.variantKey === intent.variantKey,
    );
    if (!variant) throw new Error('Audience selected an unknown campaign variant');
    const token = await createUnsubscribeToken(
      { contactId: intent.contactId, campaignId: campaign.campaignId },
      options.unsubscribeSecret,
    );
    const unsubscribe = new URL(unsubscribeBaseUrl);
    unsubscribe.searchParams.set('token', token);
    const storeName =
      store.data.name.en ??
      Object.entries(store.data.name).sort(([a], [b]) => (a < b ? -1 : 1))[0]?.[1] ??
      '';
    const values = {
      UNSUB: unsubscribe.toString(),
      STORE: storeName,
      STORE_URL: safeUrl(options.storeUrl(intent.storeId)),
    };
    const refs = [variant.lead, variant.service, ...campaign.sharedBlocks];
    const subject = fill(variant.subject, values, false);
    if (/[\r\n]/.test(subject)) throw new Error('Mail subject cannot contain header delimiters');
    prepared.push({
      intent,
      message: {
        to: contact.data.address.trim(),
        from: options.from,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        subject,
        html: `<span style="display:none">${escapeHtml(fill(variant.preheader, values, false))}</span>\n${fill(refs.map((ref) => contents.get(ref.id)!.html).join('\n'), values, true)}`,
        text: fill(refs.map((ref) => contents.get(ref.id)!.text).join('\n\n'), values, false),
        headers: {
          'List-Unsubscribe': `<${unsubscribe.toString()}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
    });
  }
  const reserved: { sendId: string; message: Omit<MailMessage, 'idempotencyKey'> }[] = [];
  for (const item of prepared) {
    // 单个意图的回执可与外部台账生成的任意 sendId 精确对应。
    const ids = await options.ledger.reserve(campaign.campaignId, [item.intent]);
    if (ids.length > 1) throw new Error('Ledger returned too many reservations');
    if (ids[0]) reserved.push({ sendId: ids[0], message: item.message });
    else stats.skipped++;
  }
  stats.reserved = reserved.length;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (const [index, item] of reserved.entries()) {
    if (index > 0 && interval > 0) await sleep(interval);
    let outcome: MailSendResult;
    try {
      outcome = await options.provider.send({ ...item.message, idempotencyKey: item.sendId });
    } catch {
      // 连接中断时无法证明服务商未收件，保留 queued，恢复时也不重发。
      needs.push({
        kind: 'action',
        action: 'reconcileSend',
        ref: item.sendId,
        reason: 'Provider outcome is uncertain; reservation is retained',
        blocking: false,
      });
      continue;
    }
    if (outcome.ok) {
      await options.ledger.report(item.sendId, { status: 'sent', providerId: outcome.providerId });
      stats.sent++;
    } else {
      await options.ledger.report(item.sendId, {
        status: 'failed',
        error: 'Provider rejected delivery',
      });
      if (outcome.permanent) await options.ledger.suppress(item.message.to, 'invalid', ctx.now);
      stats.failed++;
    }
  }
  return result(stats, needs);
}

export async function applyLedgerPatches(
  patches: readonly LedgerPatch[],
  ctx: StepCtx,
  ledger: SupplyLedger,
): Promise<void> {
  for (const patch of patches) {
    if (patch.kind === 'event') await ledger.event(patch.providerId, patch.event, patch.at);
    else {
      const contact = await ctx.assets.get(storeContactSlot, patch.contactId);
      if (!contact || contact.redacted?.length)
        throw new Error('Suppression contact is missing or redacted');
      await ledger.suppress(contact.data.address, patch.reason, patch.at);
    }
  }
}
export async function handleProviderWebhook(
  request: WebhookRequest,
  secret: string | undefined,
  ctx: StepCtx,
  provider: MailProvider,
  ledger: SupplyLedger,
) {
  if (!secret) return { active: false, result: null };
  const events = await provider.parseWebhook(request, secret);
  const merged = {
    patches: [] as LedgerPatch[],
    verifications: [] as Awaited<ReturnType<typeof ingestEvents.run>>['verifications'],
    needs: [] as Need[],
  };
  for (let offset = 0; offset < events.length; offset += 200) {
    const step = await ingestEvents.run({ events: events.slice(offset, offset + 200) }, ctx);
    merged.needs.push(...step.needs);
    merged.verifications.push(...step.verifications);
    if (step.output) {
      await applyLedgerPatches(step.output.patches, ctx, ledger);
      merged.patches.push(...step.output.patches);
    }
  }
  if (!merged.needs.some((need) => need.blocking)) await provider.ackWebhook?.(request, secret);
  return {
    active: true,
    result: result({ patches: merged.patches }, merged.needs, merged.verifications),
  };
}
export async function handleUnsubscribe(
  token: string,
  secret: string,
  ctx: StepCtx,
  ledger: SupplyLedger,
): Promise<boolean> {
  const payload = await verifyUnsubscribeToken(token, secret);
  if (!payload) return false;
  const contact = await ctx.assets.get(storeContactSlot, payload.contactId);
  if (!contact || contact.redacted?.length) return false;
  await ledger.suppress(contact.data.address, 'optout', ctx.now);
  return true;
}
