import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '@osw/core/node';
import { workflow as deliveryWorkflow } from '@osw/landed-delivery';
import { connectTestServer, testDirectory } from '@osw/mcp/testing';
import { expect, it, vi } from 'vitest';
import { deliveryFixture } from '../scripts/generate-delivery-example.mjs';
const tempDirectory = () => testDirectory();
const connect = connectTestServer;
it('discovers all landed-delivery steps and returns identical compliance needs through CLI and MCP', async () => {
  const fixture = await deliveryFixture();
  const directory = await tempDirectory();
  await writeFile(join(directory, 'delivery.json'), JSON.stringify(fixture.input));
  const output: string[] = [];
  const record = vi.spyOn(fixture.source, 'recordVerification');
  expect(
    await runCli(
      [
        'landed-delivery',
        'screenCompliance',
        '--in',
        'delivery.json',
        '--now',
        fixture.ctx.now,
        '--actor',
        fixture.ctx.actor,
      ],
      {
        cwd: directory,
        workflows: [deliveryWorkflow],
        source: fixture.source,
        stdout: (text) => output.push(text),
      },
    ),
  ).toBe(2);
  const { client } = await connect({
    workflows: [deliveryWorkflow],
    source: fixture.source,
    now: fixture.ctx.now,
    actor: fixture.ctx.actor,
  });
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const step of deliveryWorkflow.steps) expect(names).toContain(step.id.replace('/', '_'));
    const result = await client.callTool({
      name: 'landed-delivery_screenCompliance',
      arguments: fixture.input,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(JSON.parse(output.join('')));
    expect(record).not.toHaveBeenCalled();
  } finally {
    await client.close();
  }
});
