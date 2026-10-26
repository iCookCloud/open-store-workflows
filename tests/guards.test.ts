import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 根目录维护脚本是供 Node 执行的 JavaScript。
import { inspectSource } from '../scripts/check-boundaries.mjs';
// @ts-expect-error 根目录维护脚本是供 Node 执行的 JavaScript。
import { parseDenylist, scanText } from '../scripts/scan-private.mjs';

describe('repository gates', () => {
  it('fails closed without a denylist and refuses an actual outgoing commit with a denied blob', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const scanner = resolve(root, 'scripts/scan-private.mjs');
    const absentEnvironment = { ...process.env, OSW_PRIVATE_DENYLIST: '' };
    expect(
      spawnSync(process.execPath, [scanner], { cwd: root, env: absentEnvironment }).status,
    ).toBe(1);
    const scratch = mkdtempSync(resolve(tmpdir(), 'osw-guard-'));
    const denylist = resolve(scratch, 'denylist.txt');
    writeFileSync(denylist, 'ExampleBlockedTerm\n');
    const git = (args: string[], input: string) =>
      execFileSync('git', args, { cwd: root, input, encoding: 'utf8' }).trim();
    // 只生成无引用的合成 Git 对象，避免改动真实分支与共享暂存区。
    const blob = git(['hash-object', '-w', '--stdin'], 'Ｅｘａｍｐｌｅ Ｂｌｏｃｋｅｄ Ｔｅｒｍ\n');
    const tree = git(['mktree'], `100644 blob ${blob}\tfixture.txt\n`);
    const commit = git(['commit-tree', tree], 'Synthetic privacy gate test\n');
    const result = spawnSync('sh', ['.githooks/pre-push'], {
      cwd: root,
      env: { ...process.env, OSW_PRIVATE_DENYLIST: denylist },
      input: `refs/heads/example ${commit} refs/heads/example ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('denylist literal');
    expect(result.stderr).not.toContain('ExampleBlockedTerm');
  });
  it('rejects private terms even with Unicode width and inserted whitespace', () => {
    const rules = parseDenylist('ExampleBlockedTerm\nre:secret[0-9]+');
    expect(scanText('Ｅｘａｍｐｌｅ Ｂｌｏｃｋｅｄ Ｔｅｒｍ', rules)).toContain(
      'denylist literal 1',
    );
    expect(scanText('s e c r e t 4 2', rules)).toContain('denylist regex 2');
    expect(scanText('Invented data with author@example.com', rules)).toEqual([]);
  });
  it('rejects empty or malformed denylist rules', () => {
    expect(() => parseDenylist('# comment only')).toThrow();
    expect(() => parseDenylist('re:[')).toThrow();
  });
  it('uses syntax rather than comments to check prohibited runtime APIs', () => {
    const path = 'packages/example/src/index.ts';
    expect(
      inspectSource('// Date.now() is prohibited\nconst text = "Math.random()";', path, true),
    ).toEqual([]);
    expect(
      inspectSource('const now = Date.now(); const d = new Date(); Math.random();', path, true),
    ).toHaveLength(3);
    expect(inspectSource('import { readFile } from "node:fs";', path, true).length).toBeGreaterThan(
      0,
    );
    expect(
      inspectSource('import { z } from "@osw/core"; const d = new Date(ctx.now);', path, true),
    ).toEqual([]);
  });
});
