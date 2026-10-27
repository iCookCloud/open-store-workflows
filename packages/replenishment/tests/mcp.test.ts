import { MemorySource } from '@osw/core';
import { executeStep } from '@osw/core/node';
import { connectTestServer } from '@osw/mcp/testing';
import { workflow as replenishmentWorkflow } from '@osw/replenishment';
import { expect, it } from 'vitest';

const now = '2030-01-01T00:00:00Z';

it('discovers replenishment tools and returns the same blocking needs as the CLI runner', async () => {
  const source = new MemorySource([], replenishmentWorkflow.slots);
  const { client } = await connectTestServer({ now, workflows: [replenishmentWorkflow], source });
  try {
    const tools = (await client.listTools()).tools;
    for (const step of replenishmentWorkflow.steps)
      expect(tools.map((tool) => tool.name)).toContain(step.id.replace('/', '_'));
    const step = replenishmentWorkflow.steps.find(
      (step) => step.id === 'replenishment/classifyStores',
    )!;
    const input = { rulesetId: 'example-missing-rules' };
    const cli = await executeStep(step, input, { source, now, actor: 'osw:mcp@0.1.0' });
    const response = await client.callTool({
      name: 'replenishment_classifyStores',
      arguments: input,
    });
    expect(response.structuredContent).toEqual(cli.result);
    expect(response.isError).not.toBe(true);
    expect(cli.exitCode).toBe(2);
  } finally {
    await client.close();
  }
});
