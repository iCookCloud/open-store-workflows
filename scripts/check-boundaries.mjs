import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

export function inspectSource(text, path, workflow = false) {
  const errors = [];
  const nodeOnly = path.includes('/node/') || path.includes('/mcp/');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const report = (node, message) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    errors.push(`${path}:${line + 1}: ${message}`);
  };
  const checkImport = (node, specifier) => {
    if (!nodeOnly && builtins.has(specifier)) report(node, 'Node builtin outside the Node adapter');
    if (workflow && !specifier.startsWith('.') && specifier !== '@osw/core') {
      report(node, 'Workflow imports must use the portable @osw/core entry point');
    }
    if (workflow && specifier.startsWith('.') && /\/\.\.\/\.\.\//.test(`/${specifier}`)) {
      const target = resolve(path, '..', specifier);
      const packageRoot = path.slice(0, path.indexOf('/src/') + 1);
      if (!target.startsWith(packageRoot))
        report(node, 'Relative import escapes the workflow package');
    }
    if (!nodeOnly && /(?:^|\/)node(?:\/|$)/.test(specifier))
      report(node, 'Portable code imports a Node adapter');
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      checkImport(node, node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === 'require' || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteral(argument)) checkImport(node, argument.text);
        else if (!nodeOnly) report(node, 'Portable modules may not load computed dependencies');
      }
      if (!nodeOnly && ['Date.now', 'Math.random'].includes(expression))
        report(node, 'Steps must use the injected clock and deterministic inputs');
      if (
        !nodeOnly &&
        ['fetch', 'globalThis.fetch'].includes(expression) &&
        !path.includes('/http/')
      )
        report(node, 'Only the HTTP adapter may call fetch');
    }
    if (
      !nodeOnly &&
      ts.isNewExpression(node) &&
      node.expression.getText(file) === 'Date' &&
      !node.arguments?.length
    ) {
      report(node, 'Steps must use the injected clock');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}

export function inspectWorkflowTools(text, path, directory, packageName) {
  const errors = [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const packageRoot = resolve(directory);
  const allowed = new Set([packageName, '@osw/core', '@osw/mcp']);
  const check = (specifier) => {
    if (specifier.startsWith('@osw/') && !allowed.has(specifier.split('/').slice(0, 2).join('/'))) {
      errors.push(
        `${path}: workflow tools must exchange artifacts as JSON, not import ${specifier}`,
      );
    }
    if (specifier.startsWith('.')) {
      const target = resolve(path, '..', specifier);
      const location = relative(packageRoot, target);
      if (location === '..' || location.startsWith('../')) {
        errors.push(`${path}: workflow tool import escapes its package: ${specifier}`);
      }
    }
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(file) === 'require')
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) check(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}

async function main() {
  const errors = [];
  for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = resolve(root, 'packages', entry.name);
    const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    const workflow = Boolean(pkg.osw?.workflow);
    if (workflow) {
      for (const dependency of Object.keys({
        ...pkg.dependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      })) {
        if (dependency !== '@osw/core')
          errors.push(`${pkg.name}: forbidden dependency ${dependency}`);
      }
    }
    for (const path of await sourceFiles(resolve(directory, 'src')))
      errors.push(...inspectSource(await readFile(path, 'utf8'), path, workflow));
    if (workflow) {
      for (const folder of ['scripts', 'tests']) {
        let paths = [];
        try {
          paths = await sourceFiles(resolve(directory, folder));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        for (const path of paths)
          errors.push(
            ...inspectWorkflowTools(await readFile(path, 'utf8'), path, directory, pkg.name),
          );
      }
    }
  }
  if (errors.length) throw new Error(errors.map((line) => line.replaceAll(root, '')).join('\n'));
  console.log('Package boundaries and deterministic runtime rules passed');
}

if (process.argv[1] && relative(fileURLToPath(import.meta.url), resolve(process.argv[1])) === '') {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
