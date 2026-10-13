import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript-v6';

const root = path.resolve('.');
const roots = [path.join(root, 'scripts'), ...fs.readdirSync(path.join(root, 'packages')).map(name => path.join(root, 'packages', name, 'scripts')).filter(dir => fs.existsSync(dir))];
function scriptFiles(scriptRoots: readonly string[]): string[] {
  return scriptRoots.flatMap(dir => fs.readdirSync(dir, { recursive: true })
    .filter(file => /\.(?:ts|mjs|mts|cjs)$/.test(String(file)) && !String(file).split(path.sep).includes('node_modules'))
    .map(file => path.join(dir, String(file))));
}
const files = scriptFiles(roots);
const paths = (JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> };
}).compilerOptions.paths;

interface Scan { files: readonly string[]; aliases: Record<string, string[]>; root: string }
const liveScan: Scan = { files, aliases: paths, root };

function importBase(file: string, specifier: string, scan: Scan): string | null {
  if (specifier.startsWith('.')) return path.resolve(path.dirname(file), specifier);
  for (const [alias, targets] of Object.entries(scan.aliases)) {
    const wildcard = alias.endsWith('/*');
    if (wildcard ? !specifier.startsWith(alias.slice(0, -1)) : specifier !== alias) continue;
    const suffix = wildcard ? specifier.slice(alias.length - 1) : '';
    const target = targets[0];
    if (target === undefined) break;
    return path.resolve(scan.root, wildcard ? target.replace(/\*$/, suffix) : target);
  }
  return null;
}

function resolves(base: string): boolean {
  if (base.split(path.sep).includes('node_modules')) return true;
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'),
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    path.join(base, 'index.ts'), path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  return candidates.some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}
function missingImports(mutate: (file: string, text: string) => string = (_file, text) => text, scan: Scan = liveScan): string[] {
  return scan.files.flatMap(file => {
    const tree = ts.createSourceFile(file, mutate(file, fs.readFileSync(file, 'utf8')), ts.ScriptTarget.Latest, true);
    const missing: string[] = [];
    const visit = (node: ts.Node): void => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const base = importBase(file, specifier.text, scan);
        if (base !== null ? !resolves(base) : Object.keys(scan.aliases).some(alias => specifier.text.startsWith(alias.split('/')[0] + '/'))) {
          missing.push(path.relative(scan.root, file) + ': ' + specifier.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return missing;
  });
}
it('resolves local and tsconfig-alias imports in repository and package scripts', () => {
  expect(files.length).toBeGreaterThan(20);
  expect(files.some(file => file.endsWith('.mjs'))).toBe(true);
  expect(missingImports()).toEqual([]);
});
it('rejects dangling imports, exports, requires and dynamic imports', () => {
  for (const statement of ["import './absent-retirement-module.js';", "export * from './absent-retirement-module.js';", "require('./absent-retirement-module.js');", "import('./absent-retirement-module.js');"]) {
    expect(missingImports((file, text) => file === files[0] ? text + '\n' + statement : text)).toContain(path.relative(root, files[0]) + ': ./absent-retirement-module.js');
  }
});
it('rejects dangling aliases and .mjs relative imports', () => {
  const typescript = files.find(file => file.endsWith('.ts'))!;
  const mjs = files.find(file => file.endsWith('.mjs'))!;
  for (const alias of ['@myco/absent-retirement-module.js', '@goondocks/myco-shared/absent-retirement-module', '@myco-server-worker/absent-retirement-module.js']) {
    expect(missingImports((file, text) => file === typescript ? `${text}\nimport '${alias}';` : text))
      .toContain(`${path.relative(root, typescript)}: ${alias}`);
  }
  expect(missingImports((file, text) => file === mjs ? `${text}\nimport './absent-retirement-module.mjs';` : text))
    .toContain(`${path.relative(root, mjs)}: ./absent-retirement-module.mjs`);
});
it('scans cjs and mts scripts while excluding node_modules files and targets', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-script-imports-'));
  try {
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    fs.writeFileSync(path.join(fixture, 'a.cjs'), "require('@fixture/absent.js');\n");
    fs.writeFileSync(path.join(fixture, 'b.mts'), 'export const b = true;\n');
    fs.writeFileSync(path.join(fixture, 'node_modules', 'c.mjs'), "import './absent.mjs';\n");
    const scan: Scan = {
      files: scriptFiles([fixture]), aliases: { '@fixture/*': ['./node_modules/*'] }, root: fixture,
    };
    expect(scan.files.map(file => path.relative(fixture, file)).sort()).toEqual(['a.cjs', 'b.mts']);
    expect(missingImports(undefined, scan)).toEqual([]);
    expect(missingImports((file, text) => file.endsWith('a.cjs') ? `${text}\nrequire('./absent.cjs');` : text, scan))
      .toContain('a.cjs: ./absent.cjs');
    expect(missingImports((file, text) => file.endsWith('b.mts') ? `${text}\nimport './absent.mts';` : text, scan))
      .toContain('b.mts: ./absent.mts');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
