import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { cliVerbModules, closureOf, codeOf, entryFiles, moduleKey, REPO_ROOT, withoutShebang } from '../helpers/import-closure.ts';
import { isLegacy } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages/myco/src');
const RETIRED = /\b(?:ensureVaultGitignoreCurrent|reconcileManagedProjectFiles|updateGitignore|reconcileAgentsMd|installInstructions|ensureAgentsMd)\b/;
const UNMANAGED = /(?:^|[/\\])(?:\.gitignore|AGENTS\.md|myco\.yaml)$/;
const WRITES = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'atomicWriteFileSync']);

/** Follow local path bindings to the literals a write target is constructed from. */
function writerViolations(source: string, file: string): string[] {
  const code = codeOf(source, file);
  const out = RETIRED.test(code) ? [`${file}: retired repository writer`] : [];
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const literals = (node: ts.Node, seen = new Set<string>()): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const value = bindings.get(node.text);
      if (value) return literals(value, new Set([...seen, node.text]));
    }
    const found: string[] = [];
    ts.forEachChild(node, child => { found.push(...literals(child, seen)); });
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree);
      if (WRITES.has(name) && node.arguments[0] && literals(node.arguments[0]).some(value => UNMANAGED.test(value))) out.push(`${file}: writes unmanaged project file`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

function violations(mutate?: (file: string, text: string) => string): string[] {
  const source = (file: string, text: string): string => {
    const changed = mutate ? mutate(file, text) : text;
    return withoutShebang(file, changed).replace(/^import\s+\w+\s+from\s+['"][^'"]+['"]\s+with\s*\{\s*type:\s*['"]file['"]\s*\};?\s*$/gm, '');
  };
  const closure = closureOf([
    ...entryFiles(SRC, ['cli.ts', 'entries/**', 'hooks/**', 'member/**', 'runner/**', 'server/**', 'mcp/stdio-bridge.ts', 'mcp/deployment-upstream.ts', 'mcp/client-call.ts']),
    ...cliVerbModules(SRC, file => isLegacy(moduleKey(file))),
  ], { stopAt: isLegacy, source });
  return [...closure.modules.keys()].filter(file => !isLegacy(file)).flatMap(file => {
    const absolute = path.join(REPO_ROOT, file);
    return writerViolations(source(absolute, fs.readFileSync(absolute, 'utf8')), file);
  });
}

it('the 2.0 closure contains no retired repository writer or unmanaged project-file write', () => {
  expect(violations()).toEqual([]);
}, 120_000);

it('rejects a restored writer and a project-file write hidden behind a local path binding', () => {
  for (const mutation of [
    'ensureVaultGitignoreCurrent(root);',
    "const retiredTarget = path.join(root, '.gitignore'); fs.writeFileSync(retiredTarget, 'changed');",
    "fs.writeFileSync(path.join(root, 'AGENTS.md'), 'changed');",
    "fs.writeFileSync(path.join(root, '.myco', 'myco.yaml'), 'changed');",
  ]) {
    expect(violations((file, text) => file === path.join(SRC, 'utils/git-exclude.ts') ? `${text}\n${mutation}\n` : text).length).toBeGreaterThan(0);
  }
}, 120_000);
