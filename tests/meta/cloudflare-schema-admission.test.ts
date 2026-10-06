import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';

const root = path.resolve(import.meta.dir, '../../packages/myco/src/server');

/** Read executable string literals, excluding comments. */
function migrationCommand(source: string): boolean {
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true));
  return literals.some((value) => /\bd1\s+migrations\s+apply\b/.test(value))
    || ['d1', 'migrations', 'apply'].every((word) => literals.includes(word));
}

it('GATE: only the common schema admission module can issue a D1 migration command', () => {
  const issuers = fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'))
    .filter((file) => migrationCommand(fs.readFileSync(path.join(root, file), 'utf8')));
  expect(issuers).toEqual(['cloudflare-schema.ts']);
});

it('detects array and command-string bypasses while ignoring comments', () => {
  expect(migrationCommand("runner.run('npx', ['d1', 'migrations', 'apply', name])")).toBe(true);
  expect(migrationCommand("run('wrangler d1 migrations apply example')")).toBe(true);
  expect(migrationCommand('// wrangler d1 migrations apply example')).toBe(false);
});
