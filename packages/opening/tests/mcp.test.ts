import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AnyAssetRecord, MemorySource, SHARED_SLOTS, versionHash } from '@osw/core';
import { runCli } from '@osw/core/node';
import type { createOswServer } from '@osw/mcp';
import { connectTestServer, testDirectory } from '@osw/mcp/testing';
import { CertSlot, ExamSlot, workflow as openingWorkflow } from '@osw/opening';
import { describe, expect, it, vi } from 'vitest';
const now = '2030-01-01T00:00:00Z';
const tempDirectory = () => testDirectory('opening-mcp');
const connect = (options: Parameters<typeof createOswServer>[0]) =>
  connectTestServer({ now, ...options });
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
