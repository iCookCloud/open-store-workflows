import type { MailMessage, MailSendResult } from '../../runner/ports.js';

export async function sendResend(
  message: MailMessage,
  apiKey: string,
  request: typeof fetch = globalThis.fetch,
): Promise<MailSendResult> {
  if (!apiKey) throw new Error('Resend API key is required');
  if (!message.to || /[\r\n,;]/.test(message.to) || !message.text.trim() || !message.html.trim())
    throw new Error('A single recipient and both message bodies are required');
  if (
    !message.from.trim() ||
    /[\r\n]/.test(message.from + message.subject + (message.replyTo ?? ''))
  )
    throw new Error('Invalid sender or subject header');
  if (!message.idempotencyKey || message.idempotencyKey.length > 256)
    throw new Error('Invalid idempotency key');
  // 传输中断不能证明邮件未被接收；让执行器保留 queued 并要求对账。
  const response = await request('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': message.idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
  });
  if (!response.ok) {
    // 认证、域名、额度故障不能把整个收件库标作无效。
    let code = '';
    try {
      code = String(((await response.json()) as { name?: string }).name ?? '');
    } catch {
      /* 状态码仍能用于恢复。 */
    }
    return {
      ok: false,
      permanent: code === 'invalid_to_address',
      error: `Provider rejected request (${response.status})`,
    };
  }
  const payload = (await response.json()) as { id?: unknown };
  if (typeof payload.id !== 'string' || !payload.id)
    throw new Error('Provider accepted request but returned no message id');
  return { ok: true, providerId: payload.id };
}
