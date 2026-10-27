import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkflowTestHost, testDirectory } from '@osw/mcp/testing';
import { expect, it } from 'vitest';
const now = '2030-01-01T00:00:00Z';
const tempDirectory = () => testDirectory('store-concept-mcp');
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
async function resolvePackage(specifier: string) {
  const resolved = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', 'console.log(import.meta.resolve(process.argv[1]))', specifier],
    { cwd: packageDirectory },
  );
  return resolved.stdout.trim();
}
it('serves its workflow over real stdio with the same blocked result as the CLI process', async () => {
  const directory = await tempDirectory();
  const input = {
    storeId: null,
    storeType: 'example-absent',
    jurisdiction: 'XE',
    timezone: 'Etc/UTC',
    currency: 'USD',
  };
  const inputFile = join(directory, 'input.json');
  const outFile = join(directory, 'result.json');
  await writeFile(inputFile, JSON.stringify(input));
  const host = await createWorkflowTestHost(packageDirectory);
  const cliFile = fileURLToPath(new URL('./cli.js', await resolvePackage('@osw/core/node')));
  const stdioFile = fileURLToPath(new URL('./stdio.js', await resolvePackage('@osw/mcp')));
  let cliCode = 0;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        cliFile,
        'store-concept',
        'resolveConcept',
        '--assets',
        directory,
        '--in',
        inputFile,
        '--out',
        outFile,
        '--now',
        now,
      ],
      { cwd: host },
    );
  } catch (error) {
    cliCode = (error as { code: number }).code;
  }
  expect(cliCode).toBe(2);
  const cliResult = JSON.parse(await readFile(outFile, 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioFile, '--assets', directory, '--now', now],
    stderr: 'pipe',
    cwd: host,
  });
  const client = new Client({ name: 'osw-stdio-test', version: '0.1.0' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.filter((tool) => tool.name.startsWith('store-concept_'))).toHaveLength(6);
    const result = await client.callTool({
      name: 'store-concept_resolveConcept',
      arguments: input,
    });
    expect(result.structuredContent).toEqual(cliResult);
    expect(cliResult.needs[0]).toMatchObject({ kind: 'asset', slot: 'calc-template' });
    const { timezone: _timezone, ...missingTimezone } = input;
    const missing = await client.callTool({
      name: 'store-concept_resolveConcept',
      arguments: missingTimezone,
    });
    expect(missing.isError).not.toBe(true);
    expect(missing.structuredContent?.needs).toEqual([
      expect.objectContaining({ kind: 'input', path: 'timezone', blocking: true }),
    ]);
  } finally {
    await client.close();
  }
});
