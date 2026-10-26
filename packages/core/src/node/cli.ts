#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Approval,
  type AssetSource,
  SHARED_SLOTS,
  type WorkflowModule,
  parseRecord,
  slotJsonSchema,
} from '../index.js';
import { collectSlots, discoverWorkflows } from './discover.js';
import { loadProviders } from './providers.js';
import {
  type Execution,
  type RunOptions,
  executeStep,
  executeWorkflow,
  openSource,
} from './runner.js';

const HELP = `osw <workflow> <step|run> --assets <directory|url> --in <file>
    [--out <file> | --out-dir <directory>] [--approvals <file>]
    [--now <ISO timestamp>] [--actor <name>] [--providers <local-module>] [--record]
osw slots [--json-schema [directory]]
osw validate <slot> <file>

Exit codes: 0 output, 2 blocking need, 1 error, 3 partial recording.
Assets may also be configured with OSW_ASSETS; HTTP credentials use OSW_TOKEN.
`;

export interface CliOptions {
  workflows?: readonly WorkflowModule[];
  providers?: RunOptions['providers'];
  stores?: RunOptions['stores'];
  source?: AssetSource;
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function parseArgs(args: readonly string[]) {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const values = new Set([
    'assets',
    'in',
    'out',
    'out-dir',
    'approvals',
    'now',
    'actor',
    'providers',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    if (flags.has(flag)) throw new Error(`Duplicate option --${flag}`);
    if (values.has(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${flag}`);
      flags.set(flag, value);
    } else if (flag === 'json-schema') {
      const value = args[i + 1];
      flags.set(flag, value && !value.startsWith('--') ? args[++i] : true);
    } else if (flag === 'record' || flag === 'help') {
      flags.set(flag, true);
    } else {
      throw new Error(`Unknown option --${flag}`);
    }
  }
  return { positionals, flags };
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function outputValue(execution: Execution<unknown>): unknown {
  const result = execution.result as Record<string, unknown>;
  return execution.records ? { ...result, recordResults: execution.records } : result;
}

export async function runCli(args: readonly string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = options.cwd ?? process.cwd();
  const path = (value: string) => resolve(cwd, value);
  try {
    const { positionals, flags } = parseArgs(args);
    if (flags.has('help') || positionals.length === 0) {
      stdout(HELP);
      return 0;
    }
    const workflows = options.workflows ?? (await discoverWorkflows({ cwd }));
    const slots = collectSlots(SHARED_SLOTS, workflows);
    if (positionals[0] === 'slots') {
      if (positionals.length !== 1) throw new Error('Usage: osw slots [--json-schema [directory]]');
      const destination = flags.get('json-schema');
      const description = slots.map((slot) => ({
        name: slot.name,
        slotVersion: slot.slotVersion,
        filterable: slot.filterable,
        sortable: slot.sortable,
        ...(slot.fieldsets ? { fieldsets: slot.fieldsets } : {}),
        ...(destination ? { schema: slotJsonSchema(slot) } : {}),
      }));
      if (typeof destination === 'string') {
        for (const slot of slots) {
          await writeJson(
            join(path(destination), `${slot.name}.schema.json`),
            slotJsonSchema(slot),
          );
        }
      }
      stdout(`${JSON.stringify(description, null, 2)}\n`);
      return 0;
    }
    if (positionals[0] === 'validate') {
      if (positionals.length !== 3) throw new Error('Usage: osw validate <slot> <file>');
      const slot = slots.find((candidate) => candidate.name === positionals[1]);
      if (!slot) throw new Error(`Unknown slot ${positionals[1]}`);
      const value = await readJson(path(positionals[2]));
      const list = Array.isArray(value)
        ? value
        : value &&
            typeof value === 'object' &&
            'items' in value &&
            Object.keys(value).every((key) => key === 'items' || key === '$example')
          ? (value as { items: unknown }).items
          : [value];
      if (!Array.isArray(list)) throw new Error('Dataset items must be an array');
      for (const record of list) {
        if (record && typeof record === 'object' && 'data' in record && 'slot' in record) {
          parseRecord(slot, record);
        } else {
          const data = slot.schema.parse(record);
          slot.validate?.(data);
        }
      }
      stdout(`${JSON.stringify({ valid: true, slot: slot.name, count: list.length })}\n`);
      return 0;
    }
    if (positionals.length !== 2) throw new Error('Usage: osw <workflow> <step|run> [options]');
    const [key, action] = positionals;
    const workflow = workflows.find((candidate) => candidate.key === key);
    if (!workflow) throw new Error(`Unknown workflow ${key}`);
    const out = flags.get('out');
    const outDir = flags.get('out-dir');
    if (typeof outDir === 'string' && action !== 'run') {
      throw new Error('--out-dir is only available for a workflow run');
    }
    if (typeof out === 'string' && typeof outDir === 'string') {
      throw new Error('Choose either --out or --out-dir');
    }
    const inputFile = flags.get('in');
    if (typeof inputFile !== 'string') throw new Error('Execution requires --in <file>');
    const assets = flags.get('assets') ?? process.env.OSW_ASSETS;
    if (!options.source && typeof assets !== 'string') {
      throw new Error('Execution requires --assets or OSW_ASSETS');
    }
    const source = options.source ?? (await openSource(String(assets), workflows));
    const input = await readJson(path(inputFile));
    const approvalFile = flags.get('approvals');
    let approvals: Approval[] = [];
    if (typeof approvalFile === 'string') {
      const raw = await readJson(path(approvalFile));
      const items = Array.isArray(raw) ? raw : (raw as { items?: unknown })?.items;
      if (!Array.isArray(items))
        throw new Error('Approvals file must contain an array or {items:[]}');
      approvals = items.map((approval) => Approval.parse(approval));
    }
    const providerFile = flags.get('providers');
    const now =
      typeof flags.get('now') === 'string' ? String(flags.get('now')) : new Date().toISOString();
    const adapters =
      typeof providerFile === 'string'
        ? await loadProviders(path(providerFile), now)
        : { providers: options.providers, stores: options.stores };
    const runOptions = {
      ...adapters,
      source,
      approvals,
      ...(typeof flags.get('now') === 'string' ? { now: String(flags.get('now')) } : {}),
      ...(typeof flags.get('actor') === 'string' ? { actor: String(flags.get('actor')) } : {}),
      record: flags.has('record'),
    };
    const execution =
      action === 'run'
        ? await executeWorkflow(workflow, input, runOptions)
        : await executeStep(
            workflow.steps.find((step) => step.id === `${key}/${action}`) ??
              (() => {
                throw new Error(`Unknown step ${key}/${action}`);
              })(),
            input,
            runOptions,
          );
    const result = outputValue(execution);
    if (typeof out === 'string') await writeJson(path(out), result);
    if (typeof outDir === 'string') {
      const run = execution.result as Awaited<ReturnType<WorkflowModule['run']>>;
      for (const definition of workflow.steps) {
        const name = definition.id.split('/').at(-1);
        if (!name || !/^[a-z][a-zA-Z0-9]*$/u.test(name))
          throw new Error('Invalid step output filename');
        const current = run.steps[definition.id] ?? run.steps[name] ?? null;
        await writeJson(join(path(outDir), `${name}.json`), current);
      }
      await writeJson(join(path(outDir), 'result.json'), result);
      await writeJson(join(path(outDir), 'artifact.json'), run.artifact);
    }
    if (typeof out !== 'string') stdout(`${JSON.stringify(result, null, 2)}\n`);
    return execution.exitCode;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  if (!process.argv[1]) return;
  if ((await realpath(process.argv[1])) !== fileURLToPath(import.meta.url)) return;
  process.exitCode = await runCli(process.argv.slice(2));
}

await main();
