import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { loadManifests } from '@myco/symbionts/detect.js';
import { cliVerbModules, closureOf, codeOf, entryFiles, filesUnder, moduleKey, REPO_ROOT, withoutShebang } from '../helpers/import-closure.ts';
import { isLegacy } from '../helpers/legacy-boundary.ts';

const SRC = path.join(REPO_ROOT, 'packages/myco/src');
const MEMBER_INSTALLER_PARAMETER_COUNT = 5;
const RETIRED = /\b(?:ensureVaultGitignoreCurrent|reconcileManagedProjectFiles|updateGitignore|reconcileAgentsMd|installInstructions|ensureAgentsMd)\b/;
const UNMANAGED = /(?:^|[/\\])(?:\.gitignore|AGENTS\.md|CLAUDE\.md|myco\.yaml|\.mcp\.json|\.codex[/\\]config\.toml|\.cursor[/\\].+|\.claude[/\\]settings\.local\.json|opencode\.json|\.vscode[/\\]mcp\.json)$/;
const HARNESS_TARGETS = loadManifests().flatMap(({ registration: reg }) => reg
  ? [reg.hooksTarget, reg.memberHooksTarget, reg.mcpTarget].filter((target): target is string => Boolean(target)) : []);
const unmanaged = (value: string): boolean => !value.startsWith('~/') && (UNMANAGED.test(value) || HARNESS_TARGETS.some(target => value === target || value.endsWith('/' + target)));
const WRITES = new Set(['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'atomicWriteFileSync', 'writeJsonFile', 'writeOrDeleteJsonFile', 'writeManagedFile', 'renameSync', 'copyFileSync', 'symlinkSync']);

/** Follow lexical bindings and local function arguments to write-target literals. */
function writerViolations(source: string, file: string): string[] {
  const code = codeOf(source, file);
  const out = RETIRED.test(code) ? [file + ': retired repository writer'] : [];
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const bindings = new Map<ts.Node, Map<string, ts.Node>>();
  const installerNames = new Set(['SymbiontInstaller']);
  const calls = new Map<ts.SignatureDeclaration, ts.CallExpression[]>();
  const literalCache = new Map<ts.Node, string[]>();
  const scopeOf = (node: ts.Node): ts.Node => {
    while (node.parent && !ts.isSourceFile(node) && !ts.isBlock(node) && !ts.isFunctionLike(node)) node = node.parent;
    return node;
  };
  const bind = (at: ts.Node, name: string, value: ts.Node): void => {
    const scope = scopeOf(at);
    if (!bindings.has(scope)) bindings.set(scope, new Map());
    bindings.get(scope)!.set(name, value);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === 'SymbiontInstaller') installerNames.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bind(node.parent, node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) bind(node.parent, node.name.text, node);
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) bind(node.parent, node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const bindingOf = (node: ts.Identifier): ts.Node | undefined => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      const value = bindings.get(at)?.get(node.text);
      if (value) return value;
    }
    return undefined;
  };
  const functionOf = (node: ts.Node, seen = new Set<ts.Node>()): ts.FunctionLikeDeclaration | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) return node;
    if (ts.isIdentifier(node)) {
      const value = bindingOf(node);
      if (value) return functionOf(value, seen);
    }
    return undefined;
  };
  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = functionOf(node.expression);
      if (fn) calls.set(fn, [...(calls.get(fn) ?? []), node]);
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(tree);
  const literals = (node: ts.Node, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return [];
    const cached = literalCache.get(node);
    if (cached) return cached;
    const next = new Set([...seen, node]);
    const read = (): string[] => {
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isIdentifier(node)) {
        const value = bindingOf(node);
        if (value) return literals(value, next);
      }
      if (ts.isParameter(node) && ts.isFunctionLike(node.parent)) {
        const index = node.parent.parameters.indexOf(node);
        return (calls.get(node.parent) ?? []).flatMap(call => call.arguments[index] ? literals(call.arguments[index], next) : []);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['join', 'resolve'].includes(node.expression.name.text)) {
        return [node.arguments.flatMap(arg => literals(arg, next)).join('/')];
      }
      const found: string[] = [];
      ts.forEachChild(node, child => { found.push(...literals(child, next)); });
      return found;
    };
    const result = [...new Set(read())];
    literalCache.set(node, result);
    return result;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && installerNames.has(node.expression.getText(tree))) {
      if ((node.arguments?.length ?? 0) > MEMBER_INSTALLER_PARAMETER_COUNT) out.push(file + ': installer has retired scope arguments');
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree);
      const targets = ['symlinkSync', 'copyFileSync'].includes(name) ? [node.arguments[1]] : name === 'renameSync' ? [...node.arguments].slice(0, 2) : [node.arguments[0]];
      if (WRITES.has(name) && targets.some(target => target && literals(target).some(value => unmanaged(value)))) out.push(file + ': writes unmanaged project file');
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
    "fs.writeFileSync(path.join(root, '.mcp.json'), '{}');",
    "fs.copyFileSync(source, path.join(root, '.vscode', 'mcp.json'));",
    "fs.symlinkSync(source, path.join(root, '.cursor', 'mcp.json'));",
    "writeJsonFile(path.join(root, '.codex', 'hooks.json'), {});",
    "writeManagedFile(path.join(root, '.opencode', 'plugins', 'myco.ts'), 'changed');",
    "const put = (f: string) => fs.appendFileSync(f, 'changed'); put(path.join(root, '.gitignore'));",
    "new SymbiontInstaller(manifest, root, pkg, false, undefined, null, 'project');",
    "const retiredTarget = path.join(root, '.gitignore'); fs.writeFileSync(retiredTarget, 'changed');",
    "fs.writeFileSync(path.join(root, 'AGENTS.md'), 'changed');",
    "fs.writeFileSync(path.join(root, '.myco', 'myco.yaml'), 'changed');",
  ]) {
    expect(violations((file, text) => file === path.join(SRC, 'utils/git-exclude.ts') ? `${text}\n${mutation}\n` : text).length).toBeGreaterThan(0);
  }
}, 120_000);

it('non-legacy modules construct installers without retired scope arguments', () => {
  const scopes = filesUnder(SRC).filter(file => !isLegacy(moduleKey(file)))
    .flatMap(file => writerViolations(fs.readFileSync(file, 'utf8'), file).filter(message => message.endsWith(': installer has retired scope arguments')));
  expect(scopes).toEqual([]);
  const file = path.join(SRC, 'symbionts/installer.ts');
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const installer = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SymbiontInstaller');
  expect(installer && ts.isClassDeclaration(installer) ? installer.members.find(ts.isConstructorDeclaration)?.parameters.length : undefined)
    .toBe(MEMBER_INSTALLER_PARAMETER_COUNT);
}, 120_000);

it('copying from an unmanaged file does not classify the read as a write', () => {
  expect(writerViolations("fs.copyFileSync(path.join(root, 'AGENTS.md'), managedTarget);", 'copy-fixture.ts')).toEqual([]);
});
