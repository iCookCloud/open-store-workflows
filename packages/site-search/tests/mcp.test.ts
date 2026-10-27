import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARED_SLOTS } from '@osw/core';
import { connectTestServer, testDirectory } from '@osw/mcp/testing';
import { describe, expect, it } from 'vitest';
const now = '2030-01-01T00:00:00Z';
const tempDirectory = () => testDirectory();
const connect = connectTestServer;
describe('site-search integration', () => {
  it('lists ten tools and executes a provider-backed surroundings scan', async () => {
    const { workflow: siteWorkflow } = await import('@osw/site-search');
    const { FileSource, loadProviders } = await import('@osw/core/node');
    const directory = fileURLToPath(new URL('../examples/', import.meta.url));
    const sampleNow = '2026-01-10T12:00:00Z';
    const adapters = await loadProviders(join(directory, 'providers.mjs'), sampleNow);
    const source = new FileSource(join(directory, 'assets'), [
      ...SHARED_SLOTS,
      ...siteWorkflow.slots,
    ]);
    const listings = JSON.parse(
      await readFile(join(directory, 'assets/listing.json'), 'utf8'),
    ).items;
    const { client, server } = await connect({
      workflows: [siteWorkflow],
      source,
      now: sampleNow,
      ...adapters,
    });
    try {
      expect(
        (await client.listTools()).tools.filter((t) => t.name.startsWith('site-search_')),
      ).toHaveLength(10);
      const output = await client.callTool({
        name: 'site-search_scanSurroundings',
        arguments: {
          decisionId: 'example-mcp',
          candidates: [listings[0]],
          track: 'example-noodle',
        },
      });
      expect(output.isError).not.toBe(true);
      const result = output.structuredContent as {
        output: { candidates: unknown[] } | null;
        needs: unknown[];
      };
      expect(result.output, JSON.stringify(result.needs)).not.toBeNull();
      expect(result.output?.candidates).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('loads only explicit valid provider modules and rejects malformed stores', async () => {
    const { loadProviders } = await import('@osw/core/node');
    const directory = await tempDirectory();
    const invalid = join(directory, 'invalid.mjs');
    await writeFile(
      invalid,
      'export const createProviders = () => ({stores:{quota:{},cache:{}}});',
    );
    await expect(loadProviders(invalid, now)).rejects.toThrow('stores');
    const missing = join(directory, 'missing.mjs');
    await writeFile(missing, 'export const providers = {};');
    await expect(loadProviders(missing, now)).rejects.toThrow('createProviders');
  });
});
