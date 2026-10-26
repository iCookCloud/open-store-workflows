import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type AnyAssetRecord,
  MemorySource,
  SHARED_SLOTS,
  type StepDef,
  type WorkflowModule,
  paramsSlot,
  versionHash,
  z,
} from '@osw/core';
import { discoverWorkflows, executeStep, runCli } from '@osw/core/node';
import { workflow as deliveryWorkflow } from '@osw/landed-delivery';
import { CertSlot, ExamSlot, workflow as openingWorkflow } from '@osw/opening';
import { workflow as replenishmentWorkflow } from '@osw/replenishment';
import { describe, expect, it, vi } from 'vitest';
import { deliveryFixture } from '../../../scripts/gen-delivery-example.mjs';
import { createOswServer, stripPrivateOutput } from '../src/index.js';

const now = '2030-01-01T00:00:00Z';
const emptyHash = '0'.repeat(64);

async function tempDirectory() {
  const base = join(process.cwd(), '.osw');
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'interfaces-'));
}

const inputSchema = z.object({
  value: z.number(),
  jurisdiction: z.string().optional(),
});
const outputSchema = z.object({
  doubled: z.number(),
  answers: z.object({ secret: z.string(), label: z.string() }),
});

const testStep: StepDef<typeof inputSchema, typeof outputSchema> = {
  id: 'store-concept/echo',
  input: inputSchema,
  output: outputSchema,
  reads: [],
  params: [],
  outputPrivate: ['/answers/secret'],
  async run(input) {
    return input.value < 0
      ? {
          output: null,
          needs: [
            { kind: 'input', path: 'value', reason: 'Use a non-negative value', blocking: true },
          ],
          verifications: [],
        }
      : {
          output: {
            doubled: input.value * 2,
            answers: { secret: 'hidden-answer', label: 'public' },
          },
          needs: [],
          verifications: [],
        };
  },
};

const workflow: WorkflowModule = {
  key: 'store-concept',
  version: '0.1.0',
  slots: [],
  steps: [testStep],
  async run(input, ctx) {
    const result = await testStep.run(inputSchema.parse(input), ctx);
    return { steps: { echo: result }, artifact: result.output, needs: result.needs };
  },
};

async function connect(options: Parameters<typeof createOswServer>[0] = {}) {
  const server = await createOswServer({
    workflows: [workflow],
    source: new MemorySource(),
    now,
    ...options,
  });
  const client = new Client({ name: 'osw-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('CLI and MCP use the same read-only runner', () => {
  it('discovers replenishment tools and returns the same blocking needs as the CLI runner', async () => {
    const source = new MemorySource([], replenishmentWorkflow.slots);
    const { client } = await connect({ workflows: [replenishmentWorkflow], source });
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
  it('returns the same input need for missing required fields without hiding internal errors', async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, 'missing.json'), '{}');
    const output: string[] = [];
    expect(
      await runCli(['store-concept', 'echo', '--in', 'missing.json'], {
        cwd: directory,
        workflows: [workflow],
        source: new MemorySource(),
        stdout: (text) => output.push(text),
      }),
    ).toBe(2);
    const expected = JSON.parse(output.join(''));
    expect(expected.needs[0]).toMatchObject({ kind: 'input', path: 'value', blocking: true });
    const { client } = await connect();
    try {
      const result = await client.callTool({ name: 'store-concept_echo', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expected);
    } finally {
      await client.close();
    }
    const broken: StepDef = {
      ...testStep,
      run: async () => {
        throw new Error('Internal failure');
      },
    };
    await expect(
      executeStep(broken, { value: 1 }, { source: new MemorySource(), now }),
    ).rejects.toThrow('Internal failure');
    const unavailable = new MemorySource();
    vi.spyOn(unavailable, 'query').mockRejectedValue(new Error('Source unavailable'));
    await expect(
      executeStep(
        {
          ...testStep,
          params: [{ key: 'example.factor', required: true, description: 'Example parameter' }],
        },
        { value: 1 },
        { source: unavailable, now },
      ),
    ).rejects.toThrow('Source unavailable');
  });

  it('publishes StepDef input schema and returns the same sanitized result as CLI', async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, 'input.json'), JSON.stringify({ value: 7 }));
    const stdout: string[] = [];
    expect(
      await runCli(['store-concept', 'echo', '--in', 'input.json', '--now', now], {
        cwd: directory,
        workflows: [workflow],
        source: new MemorySource(),
        stdout: (text) => stdout.push(text),
      }),
    ).toBe(0);
    const cliResult = JSON.parse(stdout.join(''));
    const { client } = await connect();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === 'store-concept_echo');
      expect(tool?.inputSchema.properties).toHaveProperty('value');
      expect(tools.some((entry) => entry.name === 'osw_record_verifications')).toBe(false);
      const result = await client.callTool({ name: 'store-concept_echo', arguments: { value: 7 } });
      expect(result.structuredContent).toEqual(
        stripPrivateOutput(cliResult, testStep.outputPrivate),
      );
      expect(JSON.stringify(result)).not.toContain('hidden-answer');
      expect(cliResult.output.answers.secret).toBe('hidden-answer');
    } finally {
      await client.close();
    }
  });

  it('lists read-only slots, enforces limit <=50, and never records a step automatically', async () => {
    const source = new MemorySource();
    const record = vi.spyOn(source, 'recordVerification');
    const { client } = await connect({ source, allowRecord: true });
    try {
      const response = await client.callTool({ name: 'osw_slots', arguments: {} });
      expect((response.structuredContent?.slots as unknown[]).length).toBe(9);
      const invalid = await client.callTool({
        name: 'osw_query',
        arguments: { slot: 'term', limit: 51 },
      });
      expect(invalid.isError).toBe(true);
      await client.callTool({ name: 'store-concept_echo', arguments: { value: 2 } });
      expect(record).not.toHaveBeenCalled();
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('osw_record_verifications');
      expect(names).toContain('osw_apply_fills');
    } finally {
      await client.close();
    }
  });

  it('returns CLI exit 2 and writes blocking needs for missing or malformed business input', async () => {
    const directory = await tempDirectory();
    await writeFile(join(directory, 'input.json'), JSON.stringify({ value: -1 }));
    const options = {
      cwd: directory,
      workflows: [workflow],
      source: new MemorySource(),
      stdout: () => {},
      stderr: () => {},
    };
    expect(
      await runCli(
        ['store-concept', 'run', '--in', 'input.json', '--now', now, '--out-dir', 'outputs'],
        options,
      ),
    ).toBe(2);
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'result.json'), 'utf8')).needs[0].kind,
    ).toBe('input');
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'echo.json'), 'utf8')).output,
    ).toBeNull();
    await writeFile(join(directory, 'bad.json'), JSON.stringify({ value: 'wrong' }));
    expect(await runCli(['store-concept', 'echo', '--in', 'bad.json'], options)).toBe(2);
    await writeFile(join(directory, 'broken.json'), '{');
    expect(await runCli(['store-concept', 'echo', '--in', 'broken.json'], options)).toBe(1);
  });

  it('overwrites previous artifact and skipped step files when a reused output directory becomes blocked', async () => {
    const directory = await tempDirectory();
    const secondStep: StepDef = { ...testStep, id: 'store-concept/afterEcho' };
    const twoStepWorkflow: WorkflowModule = {
      ...workflow,
      steps: [testStep, secondStep],
      async run(input, ctx) {
        const first = await testStep.run(inputSchema.parse(input), ctx);
        if (first.output === null)
          return { steps: { echo: first }, artifact: null, needs: first.needs };
        const second = await secondStep.run(input, ctx);
        return {
          steps: { echo: first, afterEcho: second },
          artifact: second.output,
          needs: second.needs,
        };
      },
    };
    const options = {
      cwd: directory,
      workflows: [twoStepWorkflow],
      source: new MemorySource(),
      stdout: () => {},
    };
    const args = [
      'store-concept',
      'run',
      '--in',
      'input.json',
      '--now',
      now,
      '--out-dir',
      'outputs',
    ];
    await writeFile(join(directory, 'input.json'), JSON.stringify({ value: 1 }));
    expect(await runCli(args, options)).toBe(0);
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'artifact.json'), 'utf8')),
    ).not.toBeNull();
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'afterEcho.json'), 'utf8')),
    ).not.toBeNull();
    await writeFile(join(directory, 'input.json'), JSON.stringify({ value: -1 }));
    expect(await runCli(args, options)).toBe(2);
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'artifact.json'), 'utf8')),
    ).toBeNull();
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'afterEcho.json'), 'utf8')),
    ).toBeNull();
    expect(
      JSON.parse(await readFile(join(directory, 'outputs', 'result.json'), 'utf8')).artifact,
    ).toBeNull();
  });

  it('returns 3 on partial recording and leaves default execution read-only', async () => {
    const source = new MemorySource();
    const record = vi
      .spyOn(source, 'recordVerification')
      .mockResolvedValue([{ status: 'source_changed' }]);
    const step: StepDef = {
      ...testStep,
      async run() {
        return {
          output: { doubled: 2, answers: { secret: 'hidden-answer', label: 'public' } },
          needs: [],
          verifications: [
            {
              asset: { slot: 'term', id: 'example-term', versionHash: emptyHash },
              purpose: 'store-concept/echo',
              verdict: 'fails',
              reason: 'Synthetic mismatch',
              at: now,
              by: 'example',
            },
          ],
        };
      },
    };
    expect((await executeStep(step, { value: 1 }, { source, now })).exitCode).toBe(0);
    expect(record).not.toHaveBeenCalled();
    const result = await executeStep(step, { value: 1 }, { source, now, record: true });
    expect(result.exitCode).toBe(3);
    expect(result.records?.[0].result.status).toBe('source_changed');
  });

  it('records only via the explicit enabled MCP write tool', async () => {
    const record = vi.fn().mockResolvedValue([{ status: 'recorded' }]);
    const source = new MemorySource();
    source.recordVerification = record;
    const { client } = await connect({ source, allowRecord: true });
    try {
      const result = await client.callTool({
        name: 'osw_record_verifications',
        arguments: {
          items: [
            {
              asset: { slot: 'term', id: 'example-term', versionHash: emptyHash },
              purpose: 'store-concept/echo',
              verdict: 'holds',
              reason: 'Example checked',
              at: now,
              by: 'example',
            },
          ],
        },
      });
      expect(record).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toEqual({ results: [{ status: 'recorded' }] });
    } finally {
      await client.close();
    }
  });

  it('prefetches scoped parameters and preserves ambiguity instead of inventing a value', async () => {
    const data = { key: 'example.factor', value: 10, appliesTo: { jurisdictions: ['XE'] } };
    const hash = await versionHash(data);
    const source = new MemorySource(
      ['a', 'b'].map((id) => ({
        slot: 'params',
        id,
        slotVersion: '0.1.0',
        versionHash: hash,
        coverage: { tier: 'general', tracks: [], jurisdictions: [], workflows: [] },
        updatedAt: now,
        data,
      })),
      [paramsSlot],
    );
    const step: StepDef = {
      ...testStep,
      params: [{ key: 'example.factor', required: true, description: 'Example factor' }],
      async run(_input, ctx) {
        const need = ctx.params.need?.('example.factor');
        return { output: null, needs: [need!], verifications: [] };
      },
    };
    const result = await executeStep(step, { value: 1, jurisdiction: 'XE' }, { source, now });
    expect(result.exitCode).toBe(2);
    expect(result.result.needs[0]).toMatchObject({ kind: 'param', reason: 'ambiguous' });
  });

  it('exports workflow slots as JSON Schema and validates envelope major versions', async () => {
    const directory = await tempDirectory();
    const output: string[] = [];
    const options = {
      cwd: directory,
      workflows: [workflow],
      stdout: (text: string) => output.push(text),
      stderr: () => {},
    };
    expect(await runCli(['slots', '--json-schema', 'schemas'], options)).toBe(0);
    expect(
      JSON.parse(await readFile(join(directory, 'schemas', 'term.schema.json'), 'utf8')).properties
        .key,
    ).toBeDefined();
    const data = { key: 'sample', kind: 'equipment', labels: { en: 'Sample' } };
    const record = {
      slot: 'term',
      id: 'sample',
      slotVersion: '9.0.0',
      versionHash: await versionHash(data),
      updatedAt: now,
      coverage: { tier: 'general' },
      data,
    };
    await writeFile(join(directory, 'invalid.json'), JSON.stringify(record));
    expect(await runCli(['validate', 'term', 'invalid.json'], options)).toBe(1);
    await writeFile(
      join(directory, 'menu.json'),
      JSON.stringify({
        title: { en: 'Example menu' },
        cuisine: 'example',
        tracks: [],
        items: [{ id: 'sample', name: { en: 'Example item' } }],
      }),
    );
    expect(await runCli(['validate', 'menu', 'menu.json'], options)).toBe(0);
  });

  it('discovers only marked installed @osw packages through their exported ESM entry', async () => {
    const directory = await tempDirectory();
    const scope = join(directory, 'node_modules', '@osw');
    const packageDirectory = join(scope, 'example');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@osw/example',
        type: 'module',
        osw: { workflow: true },
        exports: { '.': { import: './index.js' } },
      }),
    );
    await writeFile(
      join(packageDirectory, 'index.js'),
      `export const workflow = {
      key: 'opening', version: '0.1.0', slots: [], steps: [],
      async run() { return {steps: {}, artifact: {example: true}, needs: []}; }
    };`,
    );
    expect((await discoverWorkflows({ moduleDirs: [scope] })).map((entry) => entry.key)).toEqual([
      'opening',
    ]);
  });

  it('serves installed workflow steps over real stdio with the same blocked result as the CLI process', async () => {
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
    const cliFile = fileURLToPath(new URL('../../core/dist/node/cli.js', import.meta.url));
    const stdioFile = fileURLToPath(new URL('../dist/stdio.js', import.meta.url));
    let cliCode = 0;
    try {
      await promisify(execFile)(process.execPath, [
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
      ]);
    } catch (error) {
      cliCode = (error as { code: number }).code;
    }
    expect(cliCode).toBe(2);
    const cliResult = JSON.parse(await readFile(outFile, 'utf8'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [stdioFile, '--assets', directory, '--now', now],
      stderr: 'pipe',
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
});

describe('private JSON pointers', () => {
  it('handles escaped keys and array elements without mutating the workflow result', () => {
    const result = {
      output: { 'a/b': { '~answer': 'private' }, list: [{ secret: 'private', visible: 1 }] },
      needs: [],
      verifications: [],
    };
    const stripped = stripPrivateOutput(result, ['/a~1b/~0answer', '/list/0/secret']);
    expect(stripped.output).toEqual({ 'a/b': {}, list: [{ visible: 1 }] });
    expect(result.output.list[0].secret).toBe('private');
  });
});

describe('opening assessment privacy across CLI and MCP', () => {
  it('protects answer keys through student paper, grading and the generic asset query while keeping public question fields', async () => {
    const examData = {
      key: 'example-assessment',
      certKey: 'example-certification',
      lang: 'en',
      version: '1',
      passScore: 60,
      questions: [
        {
          no: 1,
          points: 100,
          manual: false,
          prompt: 'Example public question',
          answer: 'Example private answer',
          rationale: 'Example private rationale',
          guide: 'Example private guide',
        },
      ],
    };
    const certData = {
      key: 'example-certification',
      standard: 'example-standard',
      title: { en: 'Example certification' },
      group: 'example-group',
      positions: [],
      critical: true,
      locked: true,
      requires: ['written'],
      defaultChecks: [],
    };
    const makeRecord = async (
      slot: string,
      id: string,
      data: unknown,
    ): Promise<AnyAssetRecord> => ({
      slot,
      id,
      slotVersion: '0.1.0',
      versionHash: await versionHash(data),
      updatedAt: now,
      coverage: { tier: 'general', tracks: [], jurisdictions: [], workflows: [] },
      example: true,
      data,
    });
    const exam = await makeRecord('exam', 'example-assessment', examData);
    const cert = await makeRecord('cert', 'example-certification', certData);
    const params = await Promise.all(
      Object.entries({
        'training.minPassScore': 60,
        'training.verify.minAttempts': 2,
        'training.verify.firstPassRateLow': 0.2,
        'training.verify.firstPassRateHigh': 0.8,
      }).map(([key, value]) => makeRecord('params', key, { key, value })),
    );
    const source = new MemorySource(
      [exam, cert, ...params],
      [...SHARED_SLOTS, ...openingWorkflow.slots],
    );
    const record = vi.spyOn(source, 'recordVerification');
    const { client } = await connect({ workflows: [openingWorkflow], source });
    const examRef = { slot: 'exam', id: exam.id, versionHash: exam.versionHash };
    const certRef = { slot: 'cert', id: cert.id, versionHash: cert.versionHash };
    const submissions = [
      { step: 'toStudentPaper', input: { examRef } },
      {
        step: 'applyExam',
        input: {
          track: 'example-track',
          jurisdiction: 'XE',
          timezone: 'UTC',
          seatId: 'example-seat',
          certKey: certData.key,
          examRef,
          history: [],
          planItem: { ...certData, ref: certRef, enabled: true, checks: [] },
          submission: {
            id: 'example-attempt',
            kind: 'written',
            by: 'example:examiner',
            answers: { '1': 'Example private answer' },
          },
        },
      },
    ];
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('opening_toStudentPaper');
      expect(names).toContain('opening_applyExam');
      const directory = await tempDirectory();
      for (const { step, input } of submissions) {
        await writeFile(join(directory, 'opening.json'), JSON.stringify(input));
        const output: string[] = [];
        expect(
          await runCli(['opening', step, '--in', 'opening.json', '--now', now], {
            cwd: directory,
            workflows: [openingWorkflow],
            source,
            stdout: (text) => output.push(text),
          }),
        ).toBe(0);
        const cliResult = JSON.parse(output.join(''));
        const response = await client.callTool({ name: `opening_${step}`, arguments: input });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toEqual(cliResult);
        for (const secret of [
          'Example private answer',
          'Example private rationale',
          'Example private guide',
        ])
          expect(JSON.stringify(response)).not.toContain(secret);
        if (step === 'toStudentPaper')
          expect(cliResult.output.questions).toEqual([
            { no: 1, points: 100, manual: false, prompt: 'Example public question' },
          ]);
        else {
          expect(cliResult.output.attempt.score).toBe(100);
          expect(cliResult.output.cell.state).toBe('passed');
          expect(cliResult.output.attempt.details).toEqual([{ no: 1, earned: 100, possible: 100 }]);
        }
      }
      const query = await client.callTool({
        name: 'osw_query',
        arguments: { slot: ExamSlot.name, limit: 1 },
      });
      expect(query.isError).not.toBe(true);
      const items = query.structuredContent?.items as AnyAssetRecord[];
      expect(items).toHaveLength(1);
      expect(items[0].data.questions).toEqual([
        { no: 1, points: 100, manual: false, prompt: 'Example public question' },
      ]);
      for (const key of ['answer', 'rationale', 'guide'])
        expect(items[0].data.questions[0]).not.toHaveProperty(key);
      expect(JSON.stringify(query)).not.toContain('Example private');
      expect((await source.get(ExamSlot, exam.id))!.data.questions[0].answer).toBe(
        'Example private answer',
      );
      expect((await source.get(CertSlot, cert.id))!.data.key).toBe(certData.key);
      expect(record).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});

// 真实第二项的 Provider 与额度存储必须穿过 MCP runner，不能只验证工具名。
describe('site-search integration', () => {
  it('lists ten tools and executes a provider-backed surroundings scan', async () => {
    const { workflow: siteWorkflow } = await import('@osw/site-search');
    const { FileSource, loadProviders } = await import('@osw/core/node');
    const directory = join(process.cwd(), 'examples/sample-store/site-search');
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

describe('build-out CLI and MCP integration', () => {
  it('discovers seven steps and returns identical approval needs through both interfaces', async () => {
    const { buildOutExample, BUILD_EXAMPLE_NOW, BUILD_EXAMPLE_ACTOR } = await import(
      '../../../scripts/gen-build-out-examples.mjs'
    );
    const { workflow: buildWorkflow } = await import('@osw/build-out');
    const { SHARED_SLOTS } = await import('@osw/core');
    const { input, records } = await buildOutExample();
    const discovered = await discoverWorkflows();
    expect(discovered.find((w) => w.key === 'build-out')?.steps.map((s) => s.id)).toEqual(
      buildWorkflow.steps.map((s) => s.id),
    );
    const source = new MemorySource(records, [...SHARED_SLOTS, ...buildWorkflow.slots]);
    const directory = await tempDirectory();
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
    const { client } = await connect({
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
