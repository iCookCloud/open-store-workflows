import { z } from '@osw/core';
import { ItemCandidate } from '../schema.js';
import { ITEMIZE_PROMPT, type ItemizerProvider } from './index.js';
export function openaiCompatibleItemizer(options: {
  fetch: typeof fetch;
  baseUrl: string;
  model: string;
  apiKey: string;
  quota: { limit: number; windowSec: number };
}): ItemizerProvider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1')
    throw new Error('Provider URL must use HTTPS');
  return {
    id: 'openai-compatible',
    model: options.model,
    quota: options.quota,
    async itemize(request, signal) {
      const response = await options.fetch(
        `${options.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `${ITEMIZE_PROMPT} Return an object with an items array matching this JSON schema: ${JSON.stringify(z.toJSONSchema(ItemCandidate))}`,
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      track: request.track,
                      zones: request.zones,
                      promptVersion: request.promptVersion,
                      images: request.images.map(({ url, ...i }) => i),
                    }),
                  },
                  ...request.images.map((i) => ({ type: 'image_url', image_url: { url: i.url } })),
                ],
              },
            ],
          }),
        },
      );
      if (!response.ok) throw new Error(`Itemizer request failed with HTTP ${response.status}`);
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Itemizer response has no content');
      const parsed = JSON.parse(content) as { items: unknown };
      return ItemCandidate.array().max(2000).parse(parsed.items);
    },
  };
}
