import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = resolve(root, 'packages', entry.name);
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  if (entry.name !== 'core' && !pkg.osw?.workflow) continue;
  await build({
    entryPoints: [resolve(directory, 'src/index.ts')],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    conditions: ['import'],
    logLevel: 'silent',
  });
  console.log(`${pkg.name}: portable bundle passed`);
}
