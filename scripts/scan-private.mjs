import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fold = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const allowedDomains = new Set([
  'example.com',
  'example.org',
  'example.net',
  'apache.org',
  'www.apache.org',
  'spdx.org',
  'github.com',
  'www.w3.org',
  'json-schema.org',
  'zod.dev',
  'biomejs.dev',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'unpkg.com',
  'pnpm.io',
  'vitest.dev',
  'www.typescriptlang.org',
  'modelcontextprotocol.io',
  'ts.sdk.modelcontextprotocol.io',
]);

export function parseDenylist(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) throw new Error('The external denylist must contain at least one rule');
  return lines.map((line, index) =>
    line.startsWith('re:')
      ? {
          label: `denylist regex ${index + 1}`,
          regex: new RegExp(line.slice(3).normalize('NFKC'), 'iu'),
        }
      : { label: `denylist literal ${index + 1}`, literal: fold(line) },
  );
}

export function scanText(text, rules) {
  const findings = [];
  const normalized = fold(text);
  for (const rule of rules) {
    if (rule.literal ? normalized.includes(rule.literal) : rule.regex.test(normalized))
      findings.push(rule.label);
  }
  // 通用规则不保存任何真实名称；日志也只输出规则名，避免复述命中的秘密。
  if (/\/(?:root|home|Users)\/[A-Za-z0-9_.-]+/u.test(text)) findings.push('private absolute path');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/u.test(text)
  )
    findings.push('credential');
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu)) {
    if (!/(?:^|\.)example\.(?:com|org|net)$/iu.test(match[1])) findings.push('non-example email');
  }
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/giu)) {
    const host = match[1].toLowerCase();
    if (
      !allowedDomains.has(host) &&
      !host.endsWith('.example.com') &&
      !['localhost', '127.0.0.1'].includes(host)
    )
      findings.push('unapproved domain');
  }
  if (
    /(?:\+\d{1,3}[- .])?\(\d{3}\)[- .]?\d{3}[- .]\d{4}\b|\+\d{1,3}[- .]\d{3}[- .]\d{3}[- .]\d{4}\b|\b1[3-9]\d{9}\b/u.test(
      text,
    )
  )
    findings.push('phone number');
  return [...new Set(findings)];
}

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function gitBlobs(revisions) {
  const rows = git('rev-list', '--objects', ...revisions)
    .trim()
    .split('\n')
    .filter(Boolean);
  const ids = [...new Set(rows.map((line) => line.split(' ', 1)[0]))];
  if (!ids.length) return [];
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: root,
    input: `${ids.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const blobIds = types
    .trim()
    .split('\n')
    .filter((line) => line.endsWith(' blob'))
    .map((line) => line.split(' ')[0]);
  const names = new Map(
    rows.map((line) => [line.split(' ', 1)[0], line.slice(line.indexOf(' ') + 1)]),
  );
  return blobIds.map((id) => ({
    name: `${names.get(id)}@${id.slice(0, 10)}`,
    text: git('cat-file', 'blob', id),
  }));
}

function inputs(args) {
  if (args[0] === '--history') return gitBlobs(['--all']);
  if (args[0] === '--pre-push') {
    const revisions = new Set();
    for (const row of readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
      const [, localSha, , remoteSha] = row.split(/\s+/);
      if (!localSha || /^0+$/u.test(localSha)) continue;
      if (!/^[0-9a-f]{40,64}$/u.test(localSha)) throw new Error('Invalid pre-push object ID');
      revisions.add(localSha);
      if (remoteSha && !/^0+$/u.test(remoteSha)) {
        try {
          git('cat-file', '-e', remoteSha);
          revisions.add(`^${remoteSha}`);
        } catch {
          /* 远端对象未在本地时扫描全部可达对象。 */
        }
      }
    }
    return revisions.size ? gitBlobs([...revisions]) : [];
  }
  if (args[0] === '--tarball') {
    if (!args[1]) throw new Error('A packed npm tarball is required');
    const tarball = resolve(args[1]);
    const names = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((name) => name && !name.endsWith('/'));
    return names.map((name) => {
      if (name.startsWith('/') || name.split('/').includes('..'))
        throw new Error('Unsafe tar member');
      return {
        name,
        text: execFileSync('tar', ['-xzOf', tarball, '--', name], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }),
      };
    });
  }
  if (args.length)
    throw new Error('Usage: scan-private [--history | --pre-push | --tarball <file>]');
  return [
    ...new Set(
      git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
        .split('\0')
        .filter(Boolean),
    ),
  ].map((name) => ({ name, text: readFileSync(resolve(root, name), 'utf8') }));
}

function main() {
  const denylist = process.env.OSW_PRIVATE_DENYLIST;
  if (!denylist) throw new Error('OSW_PRIVATE_DENYLIST must point to an external denylist file');
  if (!relative(root, resolve(denylist)).startsWith('..'))
    throw new Error('The denylist must be outside the repository');
  const rules = parseDenylist(readFileSync(denylist, 'utf8'));
  const files = inputs(process.argv.slice(2));
  const errors = files.flatMap(({ name, text }) =>
    scanText(text, rules).map((rule) => `${name}: ${rule}`),
  );
  if (errors.length) throw new Error(`Private data scan refused:\n${errors.join('\n')}`);
  console.log(`Private data scan passed: ${files.length} blobs/files`);
}

if (process.argv[1] && relative(fileURLToPath(import.meta.url), resolve(process.argv[1])) === '') {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
