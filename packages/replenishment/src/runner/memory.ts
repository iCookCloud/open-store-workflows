import { IsoDateTime, canonicalJson, versionHash } from '@osw/core';
import { ReorderOrder } from '../models-reorder.js';
import { SendIntent, SendLog, Suppression } from '../models.js';
import {
  MemoryWebhookReplayStore,
  acknowledgeSvixWebhook,
  parseResendEvents,
  verifySvixWebhook,
} from '../provider-resend/webhook.js';
import {
  type MailMessage,
  type MailProvider,
  type MailSendResult,
  type ProviderEvent,
  type SupplyLedger,
  type WebhookRequest,
  advanceEvent,
} from './ports.js';

export async function sendIdFor(campaignId: string, contactId: string): Promise<string> {
  return `send-${await versionHash({ campaignId, contactId })}`;
}

export class MemorySupplyLedger implements SupplyLedger {
  private readonly logs = new Map<string, SendLog>();
  private readonly suppressions = new Map<string, Suppression>();
  private readonly orders = new Map<string, { order: ReorderOrder; versionHash: string }>();
  private readonly campaigns: Map<string, string>;
  readonly now: string;

  constructor(options: {
    now: string;
    campaigns: readonly { campaignId: string; topicKey: string; sourceRef?: string }[];
  }) {
    this.now = IsoDateTime.parse(options.now);
    this.campaigns = new Map(
      options.campaigns.map((campaign) => [campaign.campaignId, campaign.topicKey]),
    );
    const sources = new Map<string, string>();
    for (const campaign of options.campaigns) {
      if (!campaign.sourceRef) continue;
      const existing = sources.get(campaign.sourceRef);
      if (existing && existing !== campaign.campaignId)
        throw new Error('Campaign sourceRef already belongs to another issue');
      sources.set(campaign.sourceRef, campaign.campaignId);
    }
  }

  async reserve(campaignId: string, intents: readonly SendIntent[]): Promise<string[]> {
    const topicKey = this.campaigns.get(campaignId);
    if (!topicKey) throw new Error('Campaign metadata must be registered before reservation');
    const ids: string[] = [];
    for (const raw of intents) {
      const intent = SendIntent.parse(raw);
      const id = await sendIdFor(campaignId, intent.contactId);
      // 哈希计算之后再查重，避免两个并行 reserve 都穿过检查。
      if (this.logs.has(id)) continue;
      this.logs.set(
        id,
        SendLog.parse({
          campaignId,
          topicKey,
          variantKey: intent.variantKey,
          contactId: intent.contactId,
          status: 'queued',
          event: 'none',
          at: this.now,
        }),
      );
      ids.push(id);
    }
    return ids;
  }

  async report(
    sendId: string,
    result: { status: 'sent' | 'failed'; providerId?: string; error?: string },
  ): Promise<void> {
    const row = this.logs.get(sendId);
    if (!row) throw new Error('Unknown send reservation');
    if (result.status === 'sent' && !result.providerId)
      throw new Error('Sent report requires providerId');
    if (row.status !== 'queued') {
      if (row.status === result.status && row.providerId === result.providerId) return;
      throw new Error('Send status is already final');
    }
    if (
      result.providerId &&
      [...this.logs.values()].some((r) => r.providerId === result.providerId)
    )
      throw new Error('Provider id is already attached to a different reservation');
    this.logs.set(sendId, SendLog.parse({ ...row, ...result }));
  }

  async event(providerId: string, event: SendLog['event'], at: string): Promise<void> {
    IsoDateTime.parse(at);
    const entry = [...this.logs].find(([, row]) => row.providerId === providerId);
    if (!entry) throw new Error('Unknown provider id');
    const [id, row] = entry;
    const next = advanceEvent(row.event, event);
    if (next !== row.event) this.logs.set(id, { ...row, event: next, eventAt: at });
  }

  async suppress(address: string, reason: Suppression['reason'], at: string): Promise<void> {
    const normalized = address.trim().toLowerCase();
    const row = Suppression.parse({ address: normalized, reason, at });
    const previous = this.suppressions.get(normalized);
    const rank = { invalid: 0, bounce: 1, optout: 2, complaint: 3 };
    if (
      !previous ||
      rank[reason] > rank[previous.reason] ||
      (rank[reason] === rank[previous.reason] && at > previous.at)
    )
      this.suppressions.set(normalized, row);
  }

  async putReorder(orderId: string, raw: ReorderOrder, ifVersionHash?: string): Promise<void> {
    const order = ReorderOrder.parse(raw);
    const nextHash = await versionHash(order);
    const previous = this.orders.get(orderId);
    if (previous?.versionHash === nextHash) return;
    if (previous ? ifVersionHash !== previous.versionHash : ifVersionHash !== undefined)
      throw new Error('Reorder version conflict');
    this.orders.set(orderId, { order: structuredClone(order), versionHash: nextHash });
  }

  snapshot() {
    return structuredClone({
      sendLogs: [...this.logs].map(([id, data]) => ({ id, data })),
      suppressions: [...this.suppressions.values()],
      reorders: [...this.orders].map(([id, value]) => ({ id, ...value })),
    });
  }
}

export class MemoryMailProvider implements MailProvider {
  readonly caps = { events: true, opens: true, clicks: true };
  readonly messages: MailMessage[] = [];
  private readonly sent = new Map<string, { content: string; result: Promise<MailSendResult> }>();
  private readonly replayStore = new MemoryWebhookReplayStore();
  constructor(
    private readonly outcome?: (message: MailMessage) => MailSendResult | Promise<MailSendResult>,
    private readonly now?: () => string,
  ) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    const content = canonicalJson(message);
    const previous = this.sent.get(message.idempotencyKey);
    if (previous) {
      if (previous.content !== content)
        throw new Error('Idempotency key reused with different content');
      return previous.result;
    }
    // 先存 promise 再调用异步实现，同一幂等键的并行调用共享一个结果。
    const result = Promise.resolve().then(async () => {
      const outcome = this.outcome
        ? await this.outcome(message)
        : { ok: true as const, providerId: `memory-${message.idempotencyKey}` };
      this.messages.push(structuredClone(message));
      return outcome;
    });
    this.sent.set(message.idempotencyKey, { content, result });
    return result;
  }

  async parseWebhook(request: WebhookRequest, secret: string): Promise<ProviderEvent[]> {
    if (!this.now) throw new Error('A webhook clock must be configured');
    const fresh = await verifySvixWebhook(request, secret, this.now(), {
      replayStore: this.replayStore,
    });
    return fresh ? parseResendEvents(request.body) : [];
  }
  async ackWebhook(request: WebhookRequest, secret: string): Promise<void> {
    if (!this.now) throw new Error('A webhook clock must be configured');
    await acknowledgeSvixWebhook(request, secret, this.now(), this.replayStore);
  }
}
