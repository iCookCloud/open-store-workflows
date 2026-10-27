import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AssetSource } from '../source.js';
import type { WorkflowModule } from '../step.js';
import { runCli } from './cli.js';

/** 示例工具只负责文件与调用约定，不包含任何 workflow 的业务数据。 */
export async function writeExampleJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readExampleJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export function exampleScratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `osw-${prefix}-`));
}

export async function createExampleWorkflowHost(packageDirectory: string): Promise<string> {
  const directory = resolve(packageDirectory);
  const pkg = await readExampleJson<{ name?: string; osw?: { workflow?: boolean } }>(
    join(directory, 'package.json'),
  );
  if (!pkg.name || !/^@osw\/[a-z][a-z0-9-]*$/.test(pkg.name) || !pkg.osw?.workflow) {
    throw new Error('Expected a marked @osw workflow package');
  }
  const host = await exampleScratch('workflow-host');
  await mkdir(join(host, 'node_modules', '@osw'), { recursive: true });
  await symlink(
    directory,
    join(host, 'node_modules', pkg.name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return host;
}

export async function compareExampleTrees(actual: string, expected: string): Promise<void> {
  const left = (await readdir(actual, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  const right = (await readdir(expected)).sort();
  assert.deepEqual(
    left.map((entry) => entry.name),
    right,
    `Example files differ: ${expected}`,
  );
  for (const entry of left) {
    const a = join(actual, entry.name);
    const b = join(expected, entry.name);
    if (entry.isDirectory()) await compareExampleTrees(a, b);
    else
      assert.equal(await readFile(a, 'utf8'), await readFile(b, 'utf8'), `Example changed: ${b}`);
  }
}

export async function runExampleCli(
  workflow: WorkflowModule,
  args: string[],
  options: { cwd: string; expectedExit: 0 | 1 | 2 | 3; source?: AssetSource },
): Promise<{ exitCode: number; result: any; stdout: string; stderr: string }> {
  if (!options.source) {
    const host = await createExampleWorkflowHost(options.cwd);
    // 真 Node 子进程通过公开包入口发现本包，避免仓库里其它已安装 workflow 掩盖缺失声明。
    const code = `import { discoverWorkflows, runCli } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
const workflows = await discoverWorkflows({ moduleDirs: [${JSON.stringify(join(host, 'node_modules', '@osw'))}] });
if (workflows.length !== 1 || workflows[0].key !== ${JSON.stringify(workflow.key)}) throw new Error('Workflow package discovery failed');
process.exitCode = await runCli(process.argv.slice(2), { workflows });`;
    const entry = join(host, 'runner.mjs');
    await writeFile(entry, code);
    const child = spawnSync(process.execPath, [entry, ...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    assert.equal(child.status, options.expectedExit, child.stderr || child.stdout);
    return {
      exitCode: child.status!,
      result: child.stdout.trim() ? JSON.parse(child.stdout) : null,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd: options.cwd,
    workflows: [workflow],
    ...(options.source ? { source: options.source } : {}),
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  assert.equal(exitCode, options.expectedExit, stderr.join('') || stdout.join(''));
  const text = stdout.join('');
  return {
    exitCode,
    result: text.trim() ? JSON.parse(text) : null,
    stdout: text,
    stderr: stderr.join(''),
  };
}
