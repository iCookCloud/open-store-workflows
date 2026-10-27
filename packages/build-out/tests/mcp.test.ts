import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySource } from '@osw/core';
import { discoverWorkflows, runCli } from '@osw/core/node';
import { connectTestServer, testDirectory } from '@osw/mcp/testing';
import { describe, expect, it } from 'vitest';

describe('build-out CLI and MCP integration', () => {
  it('discovers seven steps and returns identical approval needs through both interfaces', async () => {
    const { buildOutExample, BUILD_EXAMPLE_NOW, BUILD_EXAMPLE_ACTOR } = await import(
      '../scripts/generate-examples.mjs'
    );
    const { workflow: buildWorkflow } = await import('@osw/build-out');
    const { SHARED_SLOTS } = await import('@osw/core');
    const { input, records } = await buildOutExample();
    const installed = await testDirectory('build-out-installed');
    await mkdir(installed, { recursive: true });
    await symlink(
      fileURLToPath(new URL('../', import.meta.url)),
      join(installed, 'build-out'),
      'dir',
    );
    const discovered = await discoverWorkflows({ moduleDirs: [installed] });
    expect(discovered.find((w) => w.key === 'build-out')?.steps.map((s) => s.id)).toEqual(
      buildWorkflow.steps.map((s) => s.id),
    );
    const source = new MemorySource(records, [...SHARED_SLOTS, ...buildWorkflow.slots]);
    const directory = await testDirectory();
    await writeFile(join(directory, 'build-input.json'), JSON.stringify(input));
    const stdout: string[] = [];
    const status = await runCli(
      [
        'build-out',
        'takeoff',
        '--in',
        'build-input.json',
        '--now',
        BUILD_EXAMPLE_NOW,
        '--actor',
        BUILD_EXAMPLE_ACTOR,
      ],
      { cwd: directory, workflows: [buildWorkflow], source, stdout: (line) => stdout.push(line) },
    );
    expect(status).toBe(2);
    const expected = JSON.parse(stdout.join(''));
    const { client } = await connectTestServer({
      workflows: [buildWorkflow],
      source,
      now: BUILD_EXAMPLE_NOW,
      actor: BUILD_EXAMPLE_ACTOR,
    });
    try {
      const list = await client.listTools();
      expect(list.tools.filter((tool) => tool.name.startsWith('build-out_'))).toHaveLength(7);
      const result = await client.callTool({ name: 'build-out_takeoff', arguments: input });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
    } finally {
      await client.close();
    }
  });
});
