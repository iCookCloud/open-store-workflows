import { ItemCandidate } from '../schema.js';
import { parseCandidateCsv } from './csv.js';
export interface ItemizerRequest {
  images: { index: number; sha256: string; url: string; aiGenerated: boolean }[];
  track: string;
  zones?: string[];
  promptVersion: string;
}
export interface ItemizerProvider {
  readonly id: string;
  readonly cacheIdentity?: unknown;
  readonly model?: string;
  readonly quota?: { limit: number; windowSec: number };
  itemize(request: ItemizerRequest, signal?: AbortSignal): Promise<ItemCandidate[]>;
}
declare module '@osw/core' {
  interface OswProviders {
    itemizer: ItemizerProvider;
  }
}
export function importedItemizer(candidates: unknown): ItemizerProvider {
  const raw =
    typeof candidates === 'string'
      ? candidates.trim().startsWith('[')
        ? JSON.parse(candidates)
        : parseCandidateCsv(candidates)
      : candidates;
  const parsed = ItemCandidate.array().max(2000).parse(raw);
  return { id: 'imported', cacheIdentity: parsed, itemize: async () => structuredClone(parsed) };
}
export const ITEMIZE_PROMPT_VERSION = 'itemize.v1';
export const ITEMIZE_PROMPT =
  'Identify purchasable items by zone. Merge repeated views of the same object and preserve image evidence. One product per line. Separate visible quantities from whole-store estimates. Mark all inferred dimensions and quantities as estimated. AI-generated images provide style only. Tables, chairs, booths and custom cabinets are custom items with 4–6 major component hints. Lights, standard decorations and equipment are whole items. Combine minor hardware and consumables. Return a JSON array of ItemCandidate objects, never prices or invented supplier identities.';
