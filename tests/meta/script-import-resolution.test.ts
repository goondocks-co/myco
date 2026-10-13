import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';

const root = path.resolve('.');
const roots = [path.join(root, 'scripts'), ...fs.readdirSync(path.join(root, 'packages')).map(name => path.join(root, 'packages', name, 'scripts')).filter(dir => fs.existsSync(dir))];
const files = roots.flatMap(dir => fs.readdirSync(dir, { recursive: true }).filter(file => /\.ts$/.test(String(file))).map(file => path.join(dir, String(file))));
function missingImports(mutate: (file: string, text: string) => string = (_file, text) => text): string[] {
  return files.flatMap(file => {
    const tree = ts.createSourceFile(file, mutate(file, fs.readFileSync(file, 'utf8')), ts.ScriptTarget.Latest, true);
    const missing: string[] = [];
    const visit = (node: ts.Node): void => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const base = path.resolve(path.dirname(file), specifier.text);
        const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, path.join(base, 'index.ts')];
        if (!candidates.some(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())) missing.push(path.relative(root, file) + ': ' + specifier.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return missing;
  });
}
it('resolves every relative import in repository and package TypeScript scripts', () => {
  expect(files.length).toBeGreaterThan(20);
  expect(missingImports()).toEqual([]);
});
it('rejects a dangling relative import, export, require and dynamic import', () => {
  for (const statement of ["import './absent-retirement-module.js';", "export * from './absent-retirement-module.js';", "require('./absent-retirement-module.js');", "import('./absent-retirement-module.js');"]) {
    expect(missingImports((file, text) => file === files[0] ? text + '\n' + statement : text)).toContain(path.relative(root, files[0]) + ': ./absent-retirement-module.js');
  }
});
