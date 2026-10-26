import type { ReorderOrder } from '../models-reorder.js';
import type { SendIntent, SendLog, Suppression } from '../models.js';

export interface MailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
  idempotencyKey: string;
}
export type MailSendResult =
  | { ok: true; providerId: string }
  | { ok: false; permanent: boolean; error: string };
export type ProviderEventKind = Exclude<SendLog['event'], 'none' | 'unsub'>;
export interface ProviderEvent {
  providerId: string;
  event: ProviderEventKind;
  at: string;
}
export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}
export interface MailProvider {
  readonly caps: { events: boolean; opens: boolean; clicks: boolean };
  send(message: MailMessage): Promise<MailSendResult>;
  parseWebhook(request: WebhookRequest, secret: string): Promise<ProviderEvent[]>;
  // 执行器成功应用所有补丁后才确认去重；失败时相同通知仍可重试。
  ackWebhook?(request: WebhookRequest, secret: string): Promise<void>;
}
export interface SupplyLedger {
  // 只返回本次新占位的 id；此前 queued、sent、failed 都不得再次发送。
  reserve(campaignId: string, intents: readonly SendIntent[]): Promise<string[]>;
  report(
    sendId: string,
    result: { status: 'sent' | 'failed'; providerId?: string; error?: string },
  ): Promise<void>;
  event(providerId: string, event: SendLog['event'], at: string): Promise<void>;
  suppress(address: string, reason: Suppression['reason'], at: string): Promise<void>;
  putReorder(orderId: string, order: ReorderOrder, ifVersionHash?: string): Promise<void>;
}

// 负面回流优先，迟到的 opened/delivered 不得清掉投诉或退订。
const EVENT_RANK: Record<SendLog['event'], number> = {
  none: 0,
  soft_bounced: 1,
  delivered: 2,
  opened: 3,
  clicked: 4,
  bounced: 5,
  unsub: 6,
  complained: 7,
};
export function advanceEvent(
  previous: SendLog['event'],
  incoming: SendLog['event'],
): SendLog['event'] {
  return EVENT_RANK[incoming] > EVENT_RANK[previous] ? incoming : previous;
}
