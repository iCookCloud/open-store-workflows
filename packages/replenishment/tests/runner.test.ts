import { type Campaign, assetRef, versionHash, type z } from '@osw/core';
import { describe, expect, it } from 'vitest';
import { campaignContentHash } from '../src/campaign.js';
import { ingestEvents } from '../src/events.js';
import { type ReorderOrder, reorderSlot } from '../src/models-reorder.js';
import { ResendMailProvider, verifySvixWebhook } from '../src/provider-resend/index.js';
import {
  MemoryMailProvider,
  MemorySupplyLedger,
  createUnsubscribeToken,
  handleProviderWebhook,
  handleUnsubscribe,
  runCampaignSend,
  verifyUnsubscribeToken,
} from '../src/runner/index.js';
import type { SupplyLedger } from '../src/runner/ports.js';
import { runReorderTransition } from '../src/runner/reorder.js';
import { NOW, context, record } from './fixtures.js';

async function signedWebhook() {
  const secretBytes = new TextEncoder().encode('example-webhook-signing-key');
  const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;
  const body = JSON.stringify({
    type: 'email.complained',
    created_at: NOW,
    data: { email_id: 'provider' },
  });
  const timestamp = String(Date.parse(NOW) / 1000);
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`event.${timestamp}.${body}`),
  );
  const signature = `v1,${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`;
  return {
    secret,
    request: {
      headers: { 'svix-id': 'event', 'svix-timestamp': timestamp, 'svix-signature': signature },
      body,
    },
  };
}
async function callbackContext(options: { reported?: boolean; complained?: boolean } = {}) {
  const records = [
    await record('store-contact', 'contact', {
      storeId: 'store',
      channel: 'email',
      address: 'store@example.com',
      verdict: 'valid',
      source: 'synthetic',
      verifiedAt: NOW,
    }),
  ];
  if (options.reported !== false)
    records.push(
      await record('send-log', 'send', {
        campaignId: 'campaign',
        topicKey: 'topic',
        variantKey: 'example',
        contactId: 'contact',
        status: 'sent',
        event: options.complained ? 'complained' : 'none',
        providerId: 'provider',
        at: NOW,
      }),
    );
  return context(records);
}

async function sendFixture() {
  const lead = await record('template', 'lead', {
    kind: 'newsletter-block',
    lang: 'en',
    title: { en: 'Example lead' },
    format: 'markdown',
    body: 'Hello {{STORE}}, example supplies are available.',
  });
  const service = await record('template', 'service', {
    kind: 'newsletter-block',
    lang: 'en',
    title: { en: 'Example service' },
    format: 'markdown',
    body: 'Visit {{STORE_URL}}. Stop messages: {{UNSUB}}',
  });
  const records = [
    lead,
    service,
    await record('segment-ruleset', 'rules', {
      segmentRegions: ['XE'],
      regionTiers: {},
      supplyCats: ['example-food'],
      trackSupply: { 'example-noodle': ['example-food'] },
      categoryAliases: {},
    }),
    await record('party', 'supplier', {
      name: { en: 'Example supplier' },
      roles: ['supplier'],
      status: 'active',
      jurisdictions: ['XE'],
      profiles: { supplier: { supplyCats: ['example-food'] } },
    }),
    await record('product', 'product', {
      name: { en: 'Example flour' },
      kind: 'catalog',
      category: 'example-food',
      goodsClass: 'food',
      status: 'active',
    }),
    await record('offer', 'offer', {
      partyId: 'supplier',
      productId: 'product',
      basis: 'catalog',
      use: 'repeat',
      currency: 'USD',
      unit: 'kg',
      tiers: [{ minQty: 0, unitPrice: 10 }],
      quotedAt: '2026-01-01',
    }),
    ...(await Promise.all(
      [0, 1].flatMap((index) => [
        record('store', `store-${index}`, {
          name: { en: `Example store ${index}` },
          status: 'operating',
          track: 'example-noodle',
          jurisdiction: 'XE',
          timezone: 'UTC',
        }),
        record('store-contact', `contact-${index}`, {
          storeId: `store-${index}`,
          channel: 'email',
          address: `store-${index}@example.com`,
          verdict: 'valid',
          source: 'synthetic',
          verifiedAt: NOW,
        }),
      ]),
    )),
  ];
  const params = {
    'nl.runMax': 10,
    'nl.capDays': 10,
    'nl.dayMax': 20,
    'nl.trial': 10,
    'nl.holdHours': 10,
    'nl.window.fromHour': 0,
    'nl.window.toHour': 24,
    'nl.window.tz': 'UTC',
    'nl.window.days': 'Mon',
    'nl.breaker.complaint': 0.1,
    'nl.breaker.unsub': 0.1,
    'nl.breaker.bounce': 0.1,
    'nl.breaker.failed': 0.1,
    'nl.breaker.minSample': 10,
    'nl.breaker.minAttempts': 10,
    'nl.provider.minIntervalMs': 10,
  };
  const campaign: z.infer<typeof Campaign> = {
    campaignId: 'campaign',
    supplierId: 'supplier',
    topicKey: 'example-food',
    topicRule: { tracks: ['example-noodle'] },
    dims: ['scene'],
    variants: [
      {
        variantKey: 'example',
        cell: { scene: 'example' },
        rule: { tracks: ['example-noodle'] },
        lead: assetRef(lead),
        service: assetRef(service),
        productIds: ['product'],
        subject: 'Example supplies for {{STORE}}',
        preheader: 'Example availability',
        expected: 2,
      },
    ],
    sharedBlocks: [],
    contentHash: '0'.repeat(64),
    state: 'draft',
  };
  campaign.contentHash = await campaignContentHash(campaign);
  const ctx = context(records, params);
  ctx.approvals = [
    {
      step: 'replenishment/selectAudience',
      subject: 'campaign:campaign',
      subjectHash: campaign.contentHash,
      decision: 'send',
      at: NOW,
      by: 'example:operator',
    },
  ];
  const ledger = new MemorySupplyLedger({ now: NOW, campaigns: [campaign] });
  return {
    records,
    ctx,
    campaign,
    ledger,
    options: {
      from: 'sender@example.com',
      unsubscribeBaseUrl: 'https://example.com/unsubscribe',
      unsubscribeSecret: 'example-unsubscribe-signing-key',
      storeUrl: (id: string) => `https://example.com/stores/${id}`,
    },
  };
}

describe('supply runner', () => {
  it('pauses for another campaign complaint and returns the operator-approved domain recovery baseline', async () => {
    const fixture = await sendFixture();
    const foreign = await record('send-log', 'foreign-send', {
      campaignId: 'foreign-campaign',
      topicKey: 'foreign-topic',
      variantKey: 'foreign',
      contactId: 'foreign-contact',
      status: 'sent',
      event: 'complained',
      providerId: 'foreign-provider',
      at: NOW,
    });
    fixture.ctx.assets = context([...fixture.records, foreign]).assets;
    const provider = new MemoryMailProvider();
    const options = { ...fixture.options, provider, ledger: fixture.ledger, sleep: async () => {} };
    const paused = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      options,
    );
    expect(paused.output).toMatchObject({ decision: 'pause-all', reserved: 0, sent: 0 });
    expect(provider.messages).toHaveLength(0);
    const approval = paused.needs.find(
      (need) => need.kind === 'approval' && need.subject === 'resume-domain',
    );
    if (!approval || approval.kind !== 'approval')
      throw new Error('Expected a domain recovery approval');
    fixture.ctx.approvals = [
      ...fixture.ctx.approvals,
      {
        step: approval.step,
        subject: approval.subject,
        subjectHash: approval.subjectHash,
        decision: 'resume',
        role: 'operator',
        by: 'example:operator',
        at: NOW,
      },
    ];
    const recovered = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      options,
    );
    expect(recovered.output).toMatchObject({
      decision: 'send',
      sent: 2,
      domainBreakerFrom: 'foreign-send',
    });
    const invalid = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      { ...options, domainBreakerFrom: 'unknown-baseline' },
    );
    expect(invalid.output).toBeNull();
    expect(invalid.needs).toContainEqual(
      expect.objectContaining({ path: 'domainBreakerFrom', blocking: true }),
    );
    expect(provider.messages).toHaveLength(2);
  });

  it('reserves before sending, limits one recipient, signs unsubscribe, and never resends a reservation', async () => {
    const fixture = await sendFixture();
    const provider = new MemoryMailProvider();
    const delays: number[] = [];
    const options = {
      ...fixture.options,
      provider,
      ledger: fixture.ledger,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
    const first = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      options,
    );
    expect(first.needs).toEqual([]);
    expect(first.output).toMatchObject({ reserved: 2, sent: 2, failed: 0 });
    expect(delays).toEqual([10]);
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[0]).toMatchObject({
      to: 'store-0@example.com',
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    expect(provider.messages[0].html).toContain('Example store 0');
    expect(provider.messages[0].text).toContain(
      'Stop messages: https://example.com/unsubscribe?token=',
    );
    const token = new URL(
      provider.messages[0].headers['List-Unsubscribe'].slice(1, -1),
    ).searchParams.get('token')!;
    expect(await verifyUnsubscribeToken(token, fixture.options.unsubscribeSecret)).toEqual({
      contactId: 'contact-0',
      campaignId: 'campaign',
    });
    const second = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      options,
    );
    expect(second.output).toMatchObject({ reserved: 0, sent: 0, skipped: 2 });
    expect(provider.messages).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain('@example.com');
  });

  it('retains queued rows after an uncertain send and suppresses permanent failures', async () => {
    const fixture = await sendFixture();
    let calls = 0;
    const provider = new MemoryMailProvider(async () => {
      calls++;
      if (calls === 1) throw new Error('Disconnected');
      return { ok: false, permanent: true, error: 'Invalid recipient' };
    });
    const options = { ...fixture.options, provider, ledger: fixture.ledger, sleep: async () => {} };
    const first = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      options,
    );
    expect(first.needs).toContainEqual(
      expect.objectContaining({ action: 'reconcileSend', blocking: false }),
    );
    expect(fixture.ledger.snapshot().sendLogs.map((row) => row.data.status)).toEqual([
      'queued',
      'failed',
    ]);
    expect(fixture.ledger.snapshot().suppressions).toContainEqual({
      address: 'store-1@example.com',
      reason: 'invalid',
      at: NOW,
    });
    await runCampaignSend({ campaign: fixture.campaign, rulesetId: 'rules' }, fixture.ctx, options);
    expect(calls).toBe(2);
  });

  it('does not send without a content-bound approval or for modified content', async () => {
    const fixture = await sendFixture();
    const provider = new MemoryMailProvider();
    fixture.campaign.variants[0].subject += ' changed';
    const output = await runCampaignSend(
      { campaign: fixture.campaign, rulesetId: 'rules' },
      fixture.ctx,
      { ...fixture.options, provider, ledger: fixture.ledger },
    );
    expect(output.output).toBeNull();
    expect(output.needs.some((need) => need.kind === 'approval')).toBe(true);
    expect(provider.messages).toHaveLength(0);
    expect(fixture.ledger.snapshot().sendLogs).toHaveLength(0);
  });

  it('reserves atomically across concurrent runs and advances events without changing sent status', async () => {
    const ledger = new MemorySupplyLedger({
      now: NOW,
      campaigns: [{ campaignId: 'campaign', topicKey: 'topic' }],
    });
    const intent = { contactId: 'contact', storeId: 'store', variantKey: 'example' };
    const reservations = await Promise.all([
      ledger.reserve('campaign', [intent]),
      ledger.reserve('campaign', [intent]),
    ]);
    expect(reservations.flat()).toHaveLength(1);
    const sendId = reservations.flat()[0];
    await ledger.report(sendId, { status: 'sent', providerId: 'provider' });
    await ledger.event('provider', 'complained', NOW);
    await ledger.event('provider', 'delivered', NOW);
    expect(ledger.snapshot().sendLogs[0].data).toMatchObject({
      status: 'sent',
      event: 'complained',
    });
    expect(await ledger.reserve('campaign', [intent])).toEqual([]);
  });

  it('validates unsubscribe signatures and resolves addresses only inside the runner', async () => {
    const fixture = await sendFixture();
    const token = await createUnsubscribeToken(
      { contactId: 'contact-0', campaignId: 'campaign' },
      fixture.options.unsubscribeSecret,
    );
    expect(await handleUnsubscribe(token, 'wrong-key', fixture.ctx, fixture.ledger)).toBe(false);
    expect(
      await handleUnsubscribe(
        token,
        fixture.options.unsubscribeSecret,
        fixture.ctx,
        fixture.ledger,
      ),
    ).toBe(true);
    expect(fixture.ledger.snapshot().suppressions).toEqual([
      { address: 'store-0@example.com', reason: 'optout', at: NOW },
    ]);
    expect(atob(token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))).not.toContain('@');
  });

  it('requires source uniqueness and optimistic versions for persisted reorder transitions', async () => {
    expect(
      () =>
        new MemorySupplyLedger({
          now: NOW,
          campaigns: [
            { campaignId: 'a', topicKey: 'topic', sourceRef: 'source' },
            { campaignId: 'b', topicKey: 'topic', sourceRef: 'source' },
          ],
        }),
    ).toThrow('sourceRef');
    const ledger = new MemorySupplyLedger({ now: NOW, campaigns: [] });
    const order: ReorderOrder = {
      storeId: 'store',
      supplierId: 'supplier',
      lines: [
        {
          id: 'line',
          lineKind: 'supplies',
          key: 'weak:example',
          weakKey: true,
          name: 'Example napkin',
          spec: 'Example pack',
          qty: 1,
          unit: 'pack',
          unitPrice: { amount: 10, currency: 'USD' },
          priceSource: 'last-paid',
        },
      ],
      skipped: [],
      state: 'draft',
      history: [{ state: 'draft', at: NOW, by: 'example:operator' }],
    };
    await ledger.putReorder('order', order);
    const row = await record('reorder', 'order', order, { slots: [reorderSlot] });
    const ctx = context([row], {}, [reorderSlot]);
    const hash = await versionHash(order.lines);
    const pending = await runReorderTransition({ orderId: 'order', action: 'submit' }, ctx, ledger);
    expect(pending.output).toBeNull();
    expect(ledger.snapshot().reorders[0].order.state).toBe('draft');
    ctx.approvals = [
      {
        step: 'replenishment/advanceReorder',
        subject: 'submit:order',
        subjectHash: hash,
        decision: 'submit',
        role: 'store',
        by: 'example:store',
        at: NOW,
      },
    ];
    const submitted = await runReorderTransition(
      { orderId: 'order', action: 'submit' },
      ctx,
      ledger,
    );
    expect(submitted.output?.order.state).toBe('submitted');
    expect(ledger.snapshot().reorders[0].order.state).toBe('submitted');
    await expect(ledger.putReorder('order', order, row.versionHash)).rejects.toThrow(
      'version conflict',
    );
  });
});

describe('provider events', () => {
  it('returns contact identifiers in suppression intents and leaves writes to the runner', async () => {
    const ctx = context([
      await record('send-log', 'send', {
        campaignId: 'campaign',
        topicKey: 'topic',
        variantKey: 'example',
        contactId: 'contact',
        status: 'sent',
        event: 'complained',
        providerId: 'provider',
        at: NOW,
      }),
      await record('store-contact', 'contact', {
        storeId: 'store',
        channel: 'email',
        address: 'store@example.com',
        verdict: 'valid',
        source: 'synthetic',
        verifiedAt: NOW,
      }),
      await record('reply', 'closed', { contactId: 'contact', kind: 'closed', receivedAt: NOW }),
    ]);
    const output = await ingestEvents.run(
      {
        events: [
          { providerId: 'provider', event: 'delivered', at: NOW },
          { providerId: 'provider', event: 'bounced', at: NOW },
        ],
        replyIds: ['closed'],
      },
      ctx,
    );
    expect(output.output?.patches).toEqual([
      { kind: 'suppression', contactId: 'contact', reason: 'bounce', at: NOW },
    ]);
    expect(output.verifications.map((item) => item.verdict)).toEqual(['fails', 'pending']);
    expect(JSON.stringify(output)).not.toContain('@example.com');
    expect(
      (await ctx.assets.get((await import('../src/slots.js')).sendLogSlot, 'send'))?.data.event,
    ).toBe('complained');
  });
});

describe('Resend adapter', () => {
  it.each(['connection', 'missing-id'] as const)(
    'keeps the real REST adapter outcome queued when delivery is uncertain (%s)',
    async (failure) => {
      const fixture = await sendFixture();
      let attempts = 0;
      const provider = new ResendMailProvider({
        apiKey: 'example-api-key',
        now: () => NOW,
        fetch: async () => {
          attempts++;
          if (attempts === 1) {
            if (failure === 'connection')
              throw new Error('Connection closed after request transmission');
            return new Response('{}', { status: 200 });
          }
          return new Response(JSON.stringify({ id: 'provider-success' }), { status: 200 });
        },
      });
      const options = {
        ...fixture.options,
        provider,
        ledger: fixture.ledger,
        sleep: async () => {},
      };
      const execution = await runCampaignSend(
        { campaign: fixture.campaign, rulesetId: 'rules' },
        fixture.ctx,
        options,
      );
      expect(execution.output).toMatchObject({ reserved: 2, sent: 1, failed: 0 });
      expect(execution.needs).toContainEqual(
        expect.objectContaining({ action: 'reconcileSend', blocking: false }),
      );
      expect(fixture.ledger.snapshot().sendLogs.map((row) => row.data.status)).toEqual([
        'queued',
        'sent',
      ]);
      await runCampaignSend(
        { campaign: fixture.campaign, rulesetId: 'rules' },
        fixture.ctx,
        options,
      );
      expect(attempts).toBe(2);
    },
  );

  it.each(['event', 'suppress'] as const)(
    'retries a signed complaint after a transient %s failure before acknowledging it',
    async (failedOperation) => {
      const { secret, request } = await signedWebhook();
      const provider = new ResendMailProvider({ apiKey: 'example-api-key', now: () => NOW });
      const ledger = new MemorySupplyLedger({
        now: NOW,
        campaigns: [{ campaignId: 'campaign', topicKey: 'topic' }],
      });
      const [sendId] = await ledger.reserve('campaign', [
        { contactId: 'contact', storeId: 'store', variantKey: 'example' },
      ]);
      await ledger.report(sendId, { status: 'sent', providerId: 'provider' });
      let fail = true;
      const unstable: SupplyLedger = {
        reserve: ledger.reserve.bind(ledger),
        report: ledger.report.bind(ledger),
        putReorder: ledger.putReorder.bind(ledger),
        event: async (...args) => {
          if (fail && failedOperation === 'event') {
            fail = false;
            throw new Error('Transient event write');
          }
          await ledger.event(...args);
        },
        suppress: async (...args) => {
          if (fail && failedOperation === 'suppress') {
            fail = false;
            throw new Error('Transient suppression write');
          }
          await ledger.suppress(...args);
        },
      };
      await expect(
        handleProviderWebhook(request, secret, await callbackContext(), provider, unstable),
      ).rejects.toThrow('Transient');
      expect(await provider.parseWebhook(request, secret)).toHaveLength(1);
      // event 已写成功而 suppression 失败时，重试的只读源已可见 complained。
      const retried = await handleProviderWebhook(
        request,
        secret,
        await callbackContext({ complained: failedOperation === 'suppress' }),
        provider,
        unstable,
      );
      expect(retried.result?.output).not.toBeNull();
      expect(ledger.snapshot().sendLogs[0].data.event).toBe('complained');
      expect(ledger.snapshot().suppressions).toEqual([
        { address: 'store@example.com', reason: 'complaint', at: NOW },
      ]);
      expect(await provider.parseWebhook(request, secret)).toEqual([]);
    },
  );

  it('keeps an early callback retryable until the send report provides its provider id', async () => {
    const { secret, request } = await signedWebhook();
    const provider = new ResendMailProvider({ apiKey: 'example-api-key', now: () => NOW });
    const ledger = new MemorySupplyLedger({
      now: NOW,
      campaigns: [{ campaignId: 'campaign', topicKey: 'topic' }],
    });
    const [sendId] = await ledger.reserve('campaign', [
      { contactId: 'contact', storeId: 'store', variantKey: 'example' },
    ]);
    const early = await handleProviderWebhook(
      request,
      secret,
      await callbackContext({ reported: false }),
      provider,
      ledger,
    );
    expect(early.result?.output).toBeNull();
    expect(early.result?.needs).toContainEqual(
      expect.objectContaining({ action: 'linkProviderEvent', blocking: true }),
    );
    expect(await provider.parseWebhook(request, secret)).toHaveLength(1);
    await ledger.report(sendId, { status: 'sent', providerId: 'provider' });
    const retried = await handleProviderWebhook(
      request,
      secret,
      await callbackContext(),
      provider,
      ledger,
    );
    expect(retried.result?.output).not.toBeNull();
    expect(ledger.snapshot().suppressions[0].reason).toBe('complaint');
    expect(await provider.parseWebhook(request, secret)).toEqual([]);
  });

  it('allows concurrent signed deliveries to converge through idempotent ledger patches', async () => {
    const { secret, request } = await signedWebhook();
    const provider = new ResendMailProvider({ apiKey: 'example-api-key', now: () => NOW });
    const ledger = new MemorySupplyLedger({
      now: NOW,
      campaigns: [{ campaignId: 'campaign', topicKey: 'topic' }],
    });
    const [sendId] = await ledger.reserve('campaign', [
      { contactId: 'contact', storeId: 'store', variantKey: 'example' },
    ]);
    await ledger.report(sendId, { status: 'sent', providerId: 'provider' });
    const ctx = await callbackContext();
    const outputs = await Promise.all([
      handleProviderWebhook(request, secret, ctx, provider, ledger),
      handleProviderWebhook(request, secret, ctx, provider, ledger),
    ]);
    expect(outputs.every((output) => output.result?.output !== null)).toBe(true);
    expect(ledger.snapshot().suppressions).toHaveLength(1);
    expect(ledger.snapshot().sendLogs[0].data.event).toBe('complained');
    expect(await provider.parseWebhook(request, secret)).toEqual([]);
  });

  it('matches the published Svix signature vector and rejects body or clock changes', async () => {
    const request = {
      headers: {
        'svix-id': 'msg_loFOjxBNrRLzqYUf',
        'svix-timestamp': '1731705121',
        'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
      },
      body: '{"event_type":"ping","data":{"success":true}}',
    };
    const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
    const vectorClock = new Date(1731705121 * 1000).toISOString();
    expect(await verifySvixWebhook(request, secret, vectorClock)).toBe(true);
    await expect(
      verifySvixWebhook({ ...request, body: `${request.body} ` }, secret, vectorClock),
    ).rejects.toThrow('signature');
    await expect(verifySvixWebhook(request, secret, NOW)).rejects.toThrow('timestamp');
  });

  it('sends a single-recipient REST payload and treats authentication failures as recoverable', async () => {
    let received: RequestInit | undefined;
    const provider = new ResendMailProvider({
      apiKey: 'example-api-key',
      now: () => NOW,
      fetch: async (_url, init) => {
        received = init;
        return new Response(JSON.stringify({ id: 'provider' }), { status: 200 });
      },
    });
    const message = {
      to: 'store@example.com',
      from: 'sender@example.com',
      subject: 'Example',
      html: '<p>Example</p>',
      text: 'Example',
      headers: { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      idempotencyKey: 'send-example',
    };
    expect(await provider.send(message)).toEqual({ ok: true, providerId: 'provider' });
    expect(JSON.parse(received!.body as string)).toMatchObject({
      to: ['store@example.com'],
      text: 'Example',
    });
    expect(received!.headers).toMatchObject({ 'Idempotency-Key': 'send-example' });
    const invalidKey = new ResendMailProvider({
      apiKey: 'example-api-key',
      now: () => NOW,
      fetch: async () =>
        new Response(JSON.stringify({ name: 'validation_error' }), { status: 401 }),
    });
    expect(await invalidKey.send(message)).toMatchObject({ ok: false, permanent: false });
  });

  it('verifies and deduplicates signed provider events, while rejecting tampered signatures', async () => {
    const { secret, request } = await signedWebhook();
    const provider = new ResendMailProvider({ apiKey: 'example-api-key', now: () => NOW });
    expect(await provider.parseWebhook(request, secret)).toEqual([
      { providerId: 'provider', event: 'complained', at: NOW },
    ]);
    expect(await provider.parseWebhook(request, secret)).toHaveLength(1);
    await provider.ackWebhook(request, secret);
    expect(await provider.parseWebhook(request, secret)).toEqual([]);
    await expect(
      provider.parseWebhook({ ...request, body: `${request.body} ` }, secret),
    ).rejects.toThrow('signature');
  });
});
