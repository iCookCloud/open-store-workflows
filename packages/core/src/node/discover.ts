import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SlotDef, WorkflowModule } from '../index.js';

export interface DiscoverOptions {
  cwd?: string;
  moduleDirs?: readonly string[];
}

function ancestors(start: string): string[] {
  const paths: string[] = [];
  let current = resolve(start);
  while (true) {
    paths.push(join(current, 'node_modules', '@osw'));
    const parent = dirname(current);
    if (current === parent) return paths;
    current = parent;
  }
}

function packageEntry(pkg: Record<string, unknown>): string {
  const exports = pkg.exports;
  let entry: unknown = exports;
  if (typeof exports === 'object' && exports !== null && '.' in exports) {
    entry = (exports as Record<string, unknown>)['.'];
  }
  if (typeof entry === 'object' && entry !== null) {
    const conditions = entry as Record<string, unknown>;
    entry = conditions.import ?? conditions.default;
  }
  if (typeof entry !== 'string') entry = pkg.module ?? pkg.main;
  if (typeof entry !== 'string' || isAbsolute(entry) || entry.split('/').includes('..')) {
    throw new Error(`Workflow package ${String(pkg.name)} has no safe ESM entry`);
  }
  return entry;
}

export function validateWorkflow(value: unknown): WorkflowModule {
  if (!value || typeof value !== 'object') throw new Error('Package has no workflow export');
  const workflow = value as WorkflowModule;
  if (
    typeof workflow.key !== 'string' ||
    typeof workflow.version !== 'string' ||
    !Array.isArray(workflow.steps) ||
    !Array.isArray(workflow.slots) ||
    typeof workflow.run !== 'function'
  ) {
    throw new Error('Invalid workflow module');
  }
  const ids = new Set<string>();
  for (const step of workflow.steps) {
    if (
      !step.id.startsWith(`${workflow.key}/`) ||
      ids.has(step.id) ||
      typeof step.run !== 'function' ||
      typeof step.input?.parse !== 'function' ||
      typeof step.output?.parse !== 'function'
    ) {
      throw new Error(`Invalid or duplicate step ${step.id}`);
    }
    ids.add(step.id);
  }
  return workflow;
}

/** 只发现显式标记的已安装包；不隐式导入工作目录里的任意源码。 */
export async function discoverWorkflows(options: DiscoverOptions = {}): Promise<WorkflowModule[]> {
  const directories = new Set(
    options.moduleDirs ?? [
      ...ancestors(options.cwd ?? process.cwd()),
      ...ancestors(dirname(fileURLToPath(import.meta.url))),
    ],
  );
  const found = new Map<string, WorkflowModule>();
  for (const directory of directories) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.sort()) {
      const packageDirectory = join(directory, name);
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!(pkg.osw as { workflow?: boolean } | undefined)?.workflow) continue;
      const module = await import(pathToFileURL(resolve(packageDirectory, packageEntry(pkg))).href);
      const workflow = validateWorkflow(module.workflow);
      const previous = found.get(workflow.key);
      if (previous && previous.version !== workflow.version) {
        throw new Error(`Conflicting installed versions of workflow ${workflow.key}`);
      }
      if (!previous) found.set(workflow.key, workflow);
    }
  }
  return [...found.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function collectSlots(
  shared: readonly SlotDef[],
  workflows: readonly WorkflowModule[],
): SlotDef[] {
  const slots = new Map<string, SlotDef>();
  for (const slot of [...shared, ...workflows.flatMap((workflow) => workflow.slots)]) {
    const existing = slots.get(slot.name);
    if (existing && existing.slotVersion !== slot.slotVersion) {
      throw new Error(`Conflicting versions of slot ${slot.name}`);
    }
    if (!existing) slots.set(slot.name, slot);
  }
  return [...slots.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
