import {
  type AssetRecordOf,
  Campaign,
  Hash,
  type Need,
  OswSourceError,
  type StepDef,
  versionHash,
  z,
} from '@osw/core';
import { campaignContentHash } from './campaign.js';
import { approvalNeed, blocked, numericParam, queryAll, result, stringParam } from './helpers.js';
import type { SendLog } from './models.js';
import { sendLogSlot } from './slots.js';

export const CampaignStats = z.object({
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  complained: z.number().int().nonnegative(),
  unsub: z.number().int().nonnegative(),
  replies: z.number().int().nonnegative(),
  orders: z.number().int().nonnegative(),
});
export const DecideSendInput = z.object({
  campaign: Campaign,
  webhookReady: z.boolean().optional(),
  domainBreakerFrom: z.string().optional(),
});
export const SendDecision = z.object({
  decision: z.enum(['send', 'hold', 'pause', 'pause-all']),
  count: z.number().int().nonnegative(),
  reason: z.string(),
  statsHash: Hash,
  domainStatsHash: Hash,
  domainBreakerFrom: z.string().optional(),
  breakerFrom: z.string().optional(),
  stats: CampaignStats,
});
const numericOptions = {
  'nl.runMax': { min: 1, max: 200, integer: true },
  'nl.dayMax': { min: 1, integer: true },
  'nl.trial': { min: 1, integer: true },
  'nl.holdHours': { min: 0 },
  'nl.window.fromHour': { min: 0, max: 23, integer: true },
  'nl.window.toHour': { min: 0, max: 24, integer: true },
  'nl.breaker.complaint': { min: 0, max: 1 },
  'nl.breaker.unsub': { min: 0, max: 1 },
  'nl.breaker.bounce': { min: 0, max: 1 },
  'nl.breaker.failed': { min: 0, max: 1 },
  'nl.breaker.minSample': { min: 1, integer: true },
  'nl.breaker.minAttempts': { min: 1, integer: true },
} as const;
export interface SendWindow {
  tz: string;
  days: string;
  fromHour: number;
  toHour: number;
}
export function inSendWindow(now: string, window: SendWindow): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.tz,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const day = parts.find((p) => p.type === 'weekday')!.value;
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const days = window.days.split(',').map((d) => d.trim());
  if (window.fromHour === window.toHour) return false;
  if (window.fromHour < window.toHour)
    return days.includes(day) && hour >= window.fromHour && hour < window.toHour;
  if (hour >= window.fromHour) return days.includes(day);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const previous = weekdays[(weekdays.indexOf(day) + 6) % 7];
  return hour < window.toHour && days.includes(previous);
}
function stats(logs: readonly { data: SendLog }[]): z.infer<typeof CampaignStats> {
  const out = {
    sent: 0,
    failed: 0,
    queued: 0,
    bounced: 0,
    complained: 0,
    unsub: 0,
    replies: 0,
    orders: 0,
  };
  for (const log of logs) {
    out[log.data.status]++;
    if (log.data.event === 'bounced') out.bounced++;
    if (log.data.event === 'complained') out.complained++;
    if (log.data.event === 'unsub') out.unsub++;
  }
  return out;
}
export const decideSend: StepDef<typeof DecideSendInput, typeof SendDecision> = {
  id: 'replenishment/decideSend',
  input: DecideSendInput,
  output: SendDecision,
  reads: ['send-log'],
  params: [
    ...Object.keys(numericOptions).map((key) => ({
      key,
      required: true,
      description: 'Campaign sending policy',
    })),
    { key: 'nl.window.tz', required: true, description: 'IANA send-window timezone' },
    { key: 'nl.window.days', required: true, description: 'Comma-separated English weekday names' },
  ],
  async run(input, ctx) {
    const needs: Need[] = [];
    const p: Record<string, number> = {};
    for (const [key, options] of Object.entries(numericOptions)) {
      const value = numericParam(ctx, key, needs, options);
      if (value !== null) p[key] = value;
    }
    const tz = stringParam(ctx, 'nl.window.tz', needs);
    const days = stringParam(ctx, 'nl.window.days', needs);
    if (
      days &&
      (!days.split(',').length ||
        days
          .split(',')
          .some((day) => !['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].includes(day.trim())))
    )
      needs.push({
        kind: 'input',
        path: 'params.nl.window.days',
        reason: 'Send-window days must use English short weekday names',
        blocking: true,
      });
    if (needs.length || !tz || !days) return blocked(needs);
    let inside = false;
    try {
      inside = inSendWindow(ctx.now, {
        tz,
        days,
        fromHour: p['nl.window.fromHour'],
        toHour: p['nl.window.toHour'],
      });
    } catch {
      return blocked([
        {
          kind: 'input',
          path: 'params.nl.window.tz',
          reason: 'Invalid IANA send-window timezone',
          blocking: true,
        },
      ]);
    }
    const now = Date.parse(ctx.now);
    let domainRecords: AssetRecordOf<SendLog>[];
    try {
      domainRecords = await queryAll(ctx.assets, sendLogSlot, null);
    } catch (error) {
      if (!(error instanceof OswSourceError) || error.code !== 'field_forbidden') throw error;
      return blocked([
        {
          kind: 'asset',
          slot: 'send-log',
          filter: null,
          reason: 'Sending policy requires visible domain delivery records',
          blocking: true,
        },
      ]);
    }
    if (domainRecords.some((record) => record.redacted?.length))
      return blocked([
        {
          kind: 'asset',
          slot: 'send-log',
          filter: null,
          reason: 'Sending policy requires visible domain delivery records',
          blocking: true,
        },
      ]);
    const domainLogs = domainRecords
      .filter((record) => Date.parse(record.data.at) <= now)
      .sort(
        (a, b) =>
          Date.parse(a.data.at) - Date.parse(b.data.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const logs = domainLogs.filter(
      (record) => record.data.campaignId === input.campaign.campaignId,
    );
    // 恢复批准绑定整个域的已见事件；前缀中任何发送或事件改变，都需要重审。
    const domainSnapshotHash = (records: readonly AssetRecordOf<SendLog>[]) =>
      versionHash(
        records.map((record) => ({
          id: record.id,
          campaignId: record.data.campaignId,
          status: record.data.status,
          event: record.data.event,
          at: record.data.at,
          eventAt: record.data.eventAt ?? null,
        })),
      );
    const domainStatsHash = await domainSnapshotHash(domainLogs);
    let domainBaseline = input.domainBreakerFrom;
    const total = stats(logs);
    const statsHash = await versionHash(
      logs.map((r) => ({
        id: r.id,
        status: r.data.status,
        event: r.data.event,
        at: r.data.at,
        eventAt: r.data.eventAt ?? null,
      })),
    );
    let baseline = input.campaign.breakerFrom;
    const output = (
      decision: z.infer<typeof SendDecision>['decision'],
      count: number,
      reason: string,
    ) => ({
      decision,
      count,
      reason,
      statsHash,
      domainStatsHash,
      ...(domainBaseline ? { domainBreakerFrom: domainBaseline } : {}),
      ...(baseline ? { breakerFrom: baseline } : {}),
      stats: total,
    });
    let domainTail = domainLogs;
    if (domainBaseline) {
      const index = domainLogs.findIndex((record) => record.id === domainBaseline);
      if (index < 0)
        return blocked([
          {
            kind: 'input',
            path: 'domainBreakerFrom',
            reason: 'Domain breaker baseline does not exist in this source',
            blocking: true,
          },
        ]);
      const baselineHash = await domainSnapshotHash(domainLogs.slice(0, index + 1));
      const need = approvalNeed(
        ctx,
        'replenishment/decideSend',
        'resume-domain',
        baselineHash,
        'resume',
        ['operator'],
      );
      if (need)
        return result(
          output(
            'pause-all',
            0,
            'Domain recovery baseline requires its explicit operator approval',
          ),
          [{ ...need, blocking: false }],
        );
      domainTail = domainLogs.slice(index + 1);
    }
    const domainStats = stats(domainTail);
    if (domainStats.complained / Math.max(domainStats.sent, 1) > p['nl.breaker.complaint']) {
      const need = approvalNeed(
        ctx,
        'replenishment/decideSend',
        'resume-domain',
        domainStatsHash,
        'resume',
        ['operator'],
      );
      if (need)
        return result(
          output('pause-all', 0, 'Complaint rate exceeds the shared sending-domain breaker'),
          [{ ...need, blocking: false }],
        );
      domainBaseline = domainLogs.at(-1)?.id;
    }
    const hash = await campaignContentHash(input.campaign);
    const approval = approvalNeed(
      ctx,
      'replenishment/selectAudience',
      `campaign:${input.campaign.campaignId}`,
      hash,
      'send',
    );
    if (hash !== input.campaign.contentHash || approval)
      return result(output('pause', 0, 'Current campaign content requires approval'), [
        ...(approval
          ? [{ ...approval, blocking: false }]
          : [
              {
                kind: 'approval' as const,
                step: 'replenishment/selectAudience',
                subject: `campaign:${input.campaign.campaignId}`,
                subjectHash: hash,
                question: 'Approve current campaign content',
                blocking: false,
              },
            ]),
      ]);
    if (input.campaign.state === 'done') return result(output('hold', 0, 'Campaign is complete'));
    if (input.campaign.state === 'paused') {
      const need = approvalNeed(
        ctx,
        'replenishment/decideSend',
        `resume:${input.campaign.campaignId}`,
        statsHash,
        'resume',
      );
      if (need)
        return result(
          output('pause', 0, 'Campaign is paused pending a statistics-bound resume approval'),
          [{ ...need, blocking: false }],
        );
      baseline = logs.at(-1)?.id;
    }
    let breakerLogs = logs;
    if (baseline) {
      const index = logs.findIndex((r) => r.id === baseline);
      if (index < 0)
        return blocked([
          {
            kind: 'input',
            path: 'campaign.breakerFrom',
            reason: 'Breaker baseline does not exist in this campaign',
            blocking: true,
          },
        ]);
      breakerLogs = logs.slice(index + 1);
    }
    const b = stats(breakerLogs);
    if (
      b.sent >= p['nl.breaker.minSample'] &&
      (b.unsub / b.sent > p['nl.breaker.unsub'] || b.bounced / b.sent > p['nl.breaker.bounce'])
    )
      return result(
        output('pause', 0, 'Unsubscribe or hard-bounce rate exceeds the campaign breaker'),
      );
    if (
      b.sent + b.failed >= p['nl.breaker.minAttempts'] &&
      b.failed / (b.sent + b.failed) > p['nl.breaker.failed']
    )
      return result(output('pause', 0, 'Failure rate exceeds the campaign breaker'));
    if (!inside) return result(output('hold', 0, 'Outside the configured sending window'));
    const usedDay = domainLogs.filter(
      (record) =>
        ['sent', 'queued'].includes(record.data.status) &&
        Date.parse(record.data.at) >= now - 86400000,
    ).length;
    const room = Math.max(0, p['nl.dayMax'] - usedDay);
    if (!room) return result(output('hold', 0, 'Rolling daily send allowance is exhausted'));
    const attempts = total.sent + total.failed + total.queued;
    if (attempts < p['nl.trial'])
      return result(
        output(
          'send',
          Math.min(p['nl.runMax'], room, p['nl.trial'] - attempts),
          'Trial allowance remains',
        ),
      );
    const trialEndedAt = logs[Math.min(p['nl.trial'], logs.length) - 1]?.data.at;
    if (!trialEndedAt || now - Date.parse(trialEndedAt) < p['nl.holdHours'] * 3600000)
      return result(output('hold', 0, 'Trial observation period has not elapsed'));
    if (!input.webhookReady || logs.every((r) => r.data.event === 'none'))
      return result(output('hold', 0, 'No verified event feedback is available after trial'));
    return result(output('send', Math.min(p['nl.runMax'], room), 'Campaign is within policy'));
  },
};
