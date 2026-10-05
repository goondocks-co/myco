import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';

const mutators = /^(write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|chmod|chown|lchmod|lchown|truncate|utimes|lutimes|fchmod|fchown|ftruncate|futimes|open|createWriteStream|createReadStream)/;
function violations(source: string, name: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && ['node:fs', 'fs'].includes(node.arguments[0].text)) {
      errors.push(`${name}: dynamic builtin fs namespace`);
    }
    ts.forEachChild(node, visit);
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || !['node:fs', 'fs'].includes(node.moduleSpecifier.text)) return;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings) return;
    const bindings = clause.namedBindings;
    if (ts.isNamespaceImport(bindings)) errors.push(`${name}: namespace fs import`);
    else for (const element of bindings.elements) {
      if (!element.isTypeOnly && mutators.test((element.propertyName ?? element.name).text)) {
        errors.push(`${name}: named fs mutator ${element.name.text}`);
      }
    }
  }
  visit(file);
  return errors;
}
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'vendor', 'vendor-src'].includes(entry.name)) return [];
    const filename = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(filename)
      : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.includes('.generated.') ? [filename] : [];
  });
}
it('refuses builtin named mutators and namespace imports throughout tests and packages', () => {
  const errors = ['tests', 'packages'].flatMap(sources)
    .flatMap((name) => violations(fs.readFileSync(name, 'utf8'), name));
  expect(errors).toEqual([]);
});
it('detects aliases and namespace imports while permitting reads and types', () => {
  expect(violations("import { writeFileSync as save } from 'node:fs'", 'fixture.ts')).toHaveLength(1);
  expect(violations("import { futimesSync, createReadStream } from 'node:fs'", 'fixture.ts')).toHaveLength(2);
  expect(violations("import * as fs from 'fs'", 'fixture.ts')).toHaveLength(1);
  expect(violations("const fs = await import('node:fs')", 'fixture.ts')).toHaveLength(1);
  expect(violations("import fs, { readFileSync, type PathLike } from 'node:fs'", 'fixture.ts')).toEqual([]);
});
