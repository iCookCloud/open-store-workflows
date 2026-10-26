import { z } from '@osw/core';

const Payload = z.object({ contactId: z.string().min(1), campaignId: z.string().min(1) }).strict();
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
    character.charCodeAt(0),
  );
}
async function key(secret: string, usage: 'sign' | 'verify') {
  if (!secret) throw new Error('Unsubscribe signing secret is required');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}
export async function createUnsubscribeToken(
  payload: z.infer<typeof Payload>,
  secret: string,
): Promise<string> {
  const data = encode(new TextEncoder().encode(JSON.stringify(Payload.parse(payload))));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await key(secret, 'sign'),
    new TextEncoder().encode(data),
  );
  return `${data}.${encode(new Uint8Array(signature))}`;
}
export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
): Promise<z.infer<typeof Payload> | null> {
  try {
    const [data, signature, extra] = token.split('.');
    if (!data || !signature || extra) return null;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await key(secret, 'verify'),
      decode(signature) as BufferSource,
      new TextEncoder().encode(data),
    );
    return valid ? Payload.parse(JSON.parse(new TextDecoder().decode(decode(data)))) : null;
  } catch {
    return null;
  }
}
