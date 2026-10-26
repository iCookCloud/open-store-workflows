import type { MailMessage, MailProvider, ProviderEvent, WebhookRequest } from '../runner/ports.js';
import { sendResend } from './http/index.js';
import {
  MemoryWebhookReplayStore,
  type WebhookReplayStore,
  acknowledgeSvixWebhook,
  parseResendEvents,
  verifySvixWebhook,
} from './webhook.js';

export {
  MemoryWebhookReplayStore,
  acknowledgeSvixWebhook,
  parseResendEvents,
  verifySvixWebhook,
} from './webhook.js';
export type { WebhookReplayStore } from './webhook.js';
export class ResendMailProvider implements MailProvider {
  readonly caps = { events: true, opens: true, clicks: true };
  private readonly replayStore: WebhookReplayStore;
  constructor(
    private readonly options: {
      apiKey: string;
      now: () => string;
      fetch?: typeof fetch;
      replayStore?: WebhookReplayStore;
    },
  ) {
    this.replayStore = options.replayStore ?? new MemoryWebhookReplayStore();
  }
  send(message: MailMessage) {
    return sendResend(message, this.options.apiKey, this.options.fetch);
  }
  async parseWebhook(request: WebhookRequest, secret: string): Promise<ProviderEvent[]> {
    const fresh = await verifySvixWebhook(request, secret, this.options.now(), {
      replayStore: this.replayStore,
    });
    return fresh ? parseResendEvents(request.body) : [];
  }
  async ackWebhook(request: WebhookRequest, secret: string): Promise<void> {
    await acknowledgeSvixWebhook(request, secret, this.options.now(), this.replayStore);
  }
}
