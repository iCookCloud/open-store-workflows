import { IsoDateTime, z } from '@osw/core';
import type { ProviderEvent, WebhookRequest } from '../runner/ports.js';

export interface WebhookReplayStore {
  has(id: string, now: number): Promise<boolean>;
  // claim 表示业务副作用已全部成功，验签或读取阶段不得提前调用。
  claim(id: string, expiresAt: number, now: number): Promise<boolean>;
}
export class MemoryWebhookReplayStore implements WebhookReplayStore {
  private readonly entries = new Map<string, number>();
  async has(id: string, now: number): Promise<boolean> {
    return (this.entries.get(id) ?? -1) >= now;
  }
  async claim(id: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [key, expiry] of this.entries) if (expiry < now) this.entries.delete(key);
    if (this.entries.has(id)) return false;
    this.entries.set(id, expiresAt);
    return true;
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error('Malformed webhook secret or signature');
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Malformed webhook secret or signature');
  }
}
async function authenticateSvixWebhook(
  request: WebhookRequest,
  secret: string,
  now: string,
  options: { toleranceSeconds?: number; replayStore?: WebhookReplayStore } = {},
): Promise<{ id: string; expiresAt: number; now: number }> {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const id = headers['svix-id'] ?? headers['webhook-id'];
  const timestamp = headers['svix-timestamp'] ?? headers['webhook-timestamp'];
  const signatures = headers['svix-signature'] ?? headers['webhook-signature'];
  const nowSeconds = new Date(IsoDateTime.parse(now)).getTime() / 1000;
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0)
    throw new Error('Invalid webhook clock tolerance');
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp))
    throw new Error('Missing webhook signature headers');
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(nowSeconds - seconds) > tolerance)
    throw new Error('Webhook timestamp is outside the accepted window');
  const keyBytes = decodeBase64(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${request.body}`);
  let valid = false;
  for (const entry of signatures.trim().split(/\s+/)) {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) continue;
    try {
      // WebCrypto 的 verify 执行恒定时间比较，不在 JS 中逐字提前返回。
      valid =
        (await crypto.subtle.verify(
          'HMAC',
          key,
          decodeBase64(signature) as BufferSource,
          signed,
        )) || valid;
    } catch {
      /* 不认识或损坏的轮换签名不能覆盖其余有效签名。 */
    }
  }
  if (!valid) throw new Error('Invalid webhook signature');
  return { id, expiresAt: seconds + tolerance, now: nowSeconds };
}

export async function verifySvixWebhook(
  request: WebhookRequest,
  secret: string,
  now: string,
  options: { toleranceSeconds?: number; replayStore?: WebhookReplayStore } = {},
): Promise<boolean> {
  const identity = await authenticateSvixWebhook(request, secret, now, options);
  return options.replayStore ? !(await options.replayStore.has(identity.id, identity.now)) : true;
}

export async function acknowledgeSvixWebhook(
  request: WebhookRequest,
  secret: string,
  now: string,
  replayStore: WebhookReplayStore,
): Promise<void> {
  const identity = await authenticateSvixWebhook(request, secret, now);
  await replayStore.claim(identity.id, identity.expiresAt, identity.now);
}

const ResendEvent = z.object({
  type: z.string(),
  created_at: IsoDateTime,
  data: z.object({ email_id: z.string().min(1) }),
});
export function parseResendEvents(raw: string): ProviderEvent[] {
  const envelope = z.object({ type: z.string() }).parse(JSON.parse(raw));
  const events: Record<string, ProviderEvent['event']> = {
    'email.delivered': 'delivered',
    'email.delivery_delayed': 'soft_bounced',
    'email.bounced': 'bounced',
    'email.complained': 'complained',
    'email.opened': 'opened',
    'email.clicked': 'clicked',
  };
  const event = events[envelope.type];
  if (!event) return [];
  const payload = ResendEvent.parse(JSON.parse(raw));
  return [{ providerId: payload.data.email_id, event, at: payload.created_at }];
}
