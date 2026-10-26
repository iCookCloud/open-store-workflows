#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Approval } from '@osw/core';
import { loadProviders } from '@osw/core/node';
import { createOswServer } from './index.js';

async function main(): Promise<void> {
  let assets = process.env.OSW_ASSETS;
  let now: string | undefined;
  let actor: string | undefined;
  let approvalFile = process.env.OSW_APPROVALS;
  let allowRecord = false;
  let providerFile = process.env.OSW_PROVIDERS;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--allow-record') {
      allowRecord = true;
    } else if (
      arg === '--assets' ||
      arg === '--now' ||
      arg === '--approvals' ||
      arg === '--actor' ||
      arg === '--providers'
    ) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--assets') assets = value;
      else if (arg === '--now') now = value;
      else if (arg === '--actor') actor = value;
      else if (arg === '--providers') providerFile = value;
      else approvalFile = value;
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  let approvals: Approval[] = [];
  if (approvalFile) {
    const raw = JSON.parse(await readFile(approvalFile, 'utf8'));
    approvals = (Array.isArray(raw) ? raw : raw.items).map((item: unknown) => Approval.parse(item));
  }
  const adapters = providerFile
    ? await loadProviders(providerFile, now ?? new Date().toISOString())
    : {};
  const server = await createOswServer({ assets, now, actor, approvals, allowRecord, ...adapters });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
