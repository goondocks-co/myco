import { expect, it } from 'bun:test';
import fs from 'node:fs';
import ts from 'typescript-v6';
import { codeOf, runtimeImportNames } from '../helpers/import-closure.ts';
import { walk } from '../helpers/2-0-closure.ts';
import { isLegacy } from '../helpers/legacy-boundary.ts';

/** Resolve local argv bindings conservatively, including every assignment to a name. */
function buildsDaemonArgv(file: string, text: string): boolean {
  const tree = ts.createSourceFile(file, codeOf(text, file), ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression[]>();
  const bind = (name: string, value: ts.Expression): void => {
    bindings.set(name, [...(bindings.get(name) ?? []), value]);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bind(node.name.text, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) bind(node.left.text, node.right);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const values = (node: ts.Expression, seen = new Set<ts.Node>()): string[] => {
    if (seen.has(node)) return [];
    const next = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) return (bindings.get(node.text) ?? []).flatMap(value => values(value, next));
    if (ts.isParenthesizedExpression(node) || ts.isSpreadElement(node)) return values(node.expression, next);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => values(element, next));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return values(node.left, next).flatMap(left => values(node.right, next).map(right => left + right));
    }
    if (ts.isTemplateExpression(node)) {
      return node.templateSpans.reduce((parts, span) => parts.flatMap(part =>
        (values(span.expression, next).length ? values(span.expression, next) : ['?']).map(value => part + value + span.literal.text)), [node.head.text]);
    }
    return [];
  };
  const comparisons = new Set([
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);
  let found = false;
  let daemonComparison = false;
  let processLaunch = false;
  const visit = (node: ts.Node): void => {
    // Command and retained-unit readers may compare a daemon token.
    if (ts.isStringLiteralLike(node) && node.text === 'daemon') {
      if (ts.isBinaryExpression(node.parent) && comparisons.has(node.parent.operatorToken.kind)) daemonComparison = true;
      else found = true;
    }
    if (ts.isCallExpression(node) && !(ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral)
      && /(?:^|\.)(?:spawn\w*|exec(?:File|Sync)?)(?:Sync)?$/.test(node.expression.getText(tree))) processLaunch = true;
    if (ts.isArrayLiteralExpression(node) && values(node).includes('daemon')) found = true;
    if (ts.isCallExpression(node) && /(?:spawn|exec)/i.test(node.expression.getText(tree))
      && node.arguments.some(arg => values(arg).some(value => /(?:^|\s)daemon(?:\s|$)/.test(value)))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found || (daemonComparison && processLaunch);
}

function daemonArgvSites(mutate?: (file: string, text: string) => string): string[] {
  const { myco, server } = walk(mutate);
  return [...myco.modules, ...server.modules].filter(([file]) => !isLegacy(file)).flatMap(([file, absolute]) => {
    const text = fs.readFileSync(absolute, 'utf8');
    return buildsDaemonArgv(file, mutate ? mutate(absolute, text) : text) ? [file] : [];
  });
}

it('nothing in the 2.0 closure constructs a daemon argv', () => {
  expect(daemonArgvSites()).toEqual([]);
}, 120_000);

it('rejects literal, bound, concatenated, spread, mutated, conditional and template daemon argv', () => {
  for (const mutation of [
    "spawn(binary, ['daemon']);",
    "const verb = 'daemon'; spawn(binary, [verb]);",
    "spawn(binary, ['dae' + 'mon']);",
    "spawn(binary, [cmd === 'daemon' ? cmd : 'worker']);",
    "const args = []; args.push('daemon'); spawn(binary, args);",
    "const args = []; args.unshift('daemon'); spawn(binary, args);",
    "const argv = ['daemon']; spawn(binary, [...argv]);",
    'spawn(binary, [`daemon`]);',
    'exec(`${binary} daemon`);',
  ]) {
    expect(daemonArgvSites((file, text) => file.endsWith('/cli/daemon-guard.ts')
      ? `${text}\n${mutation}` : text)).toContain('packages/myco/src/cli/daemon-guard.ts');
  }
}, 120_000);

/** The runtime names each 2.0 caller may use across the retained 1.4 boundary. */
const LEGACY_IMPORT_NAMES: Readonly<Record<string, readonly string[]>> = {
  'cli.ts -> vault/resolve.ts': ['resolveVaultDir'],
  'cli.ts -> cli/agent-run.ts': ['AGENT_USAGE','run'],
  'cli.ts -> cli/agent-tasks.ts': ['TASK_RUN_USAGE','TASK_USAGE','run'],
  'cli.ts -> cli/grove.ts': ['USAGE','run'],
  'cli.ts -> cli/subsystem.ts': ['USAGE','run'],
  'cli.ts -> cli/remove.ts': ['USAGE','run'],
  'cli.ts -> cli/doctor.ts': ['USAGE','run'],
  'cli.ts -> cli/setup-llm.ts': ['USAGE','run'],
  'cli.ts -> cli/join.ts': ['JOIN_HELP','LEAVE_HELP','runJoin','runLeave'],
  'cli.ts -> cli/host.ts': ['HOST_HELP','runHostCommand'],
  'cli.ts -> backup/pre-migration-checkpoint.ts': ['installPreMigrationCheckpoint'],
  'cli.ts -> cli/restore-backup.ts': ['run'],
  'cli.ts -> cli/detect-providers.ts': ['run'],
  'cli.ts -> cli/service.ts': ['run'],
  'cli.ts -> cli/attach.ts': ['runAttach','runDetach'],
  'cli.ts -> cli/restart.ts': ['run'],
  'cli.ts -> cli/config.ts': ['run'],
  'cli.ts -> cli/verify.ts': ['run'],
  'cli.ts -> cli/stats.ts': ['run'],
  'cli.ts -> cli/search.ts': ['run','runVectors'],
  'cli.ts -> cli/session.ts': ['run'],
  'cli.ts -> cli/setup-digest.ts': ['run'],
  'cli.ts -> cli/logs.ts': ['run'],
};

function unapprovedLegacyImports(mutate?: (file: string, text: string) => string): string[] {
  const short = (key: string): string => key.replace(/^packages\/myco\/src\//, '');
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const closure of Object.values(walk(mutate))) {
    for (const [from, targets] of closure.edges) {
      if (isLegacy(from) || ![...targets].some(isLegacy)) continue;
      const absolute = closure.modules.get(from)!;
      const raw = fs.readFileSync(absolute, 'utf8');
      const names = runtimeImportNames(mutate ? mutate(absolute, raw) : raw, absolute);
      for (const to of targets) {
        if (!isLegacy(to)) continue;
        const edge = short(from) + ' -> ' + short(to);
        seen.add(edge);
        const imported = [...(names.get(to) ?? [])].sort();
        if (JSON.stringify(imported) !== JSON.stringify(LEGACY_IMPORT_NAMES[edge])) {
          violations.push(edge + ': ' + imported.join(', '));
        }
      }
    }
  }
  for (const edge of Object.keys(LEGACY_IMPORT_NAMES)) {
    if (!seen.has(edge)) violations.push('retired edge: delete ' + edge);
  }
  return violations;
}

it('every 2.0 import into a retained 1.4 helper names only the allowed exports', () => {
  expect(unapprovedLegacyImports()).toEqual([]);
}, 120_000);

it('rejects a daemon service builder added over an existing helper edge', () => {
  for (const addition of [
    "import { buildServiceSpec } from '../service/spec-builder.js';",
    "import { buildServiceSpec as buildUnit } from '../service/spec-builder.js';",
    "import * as specs from '../service/spec-builder.js';",
    "export { buildServiceSpec } from '../service/spec-builder.js';",
    "const { buildServiceSpec } = await import('../service/spec-builder.js');",
    "const buildUnit = (await import('../service/spec-builder.js')).buildServiceSpec;",
    "const specs = require('../service/spec-builder.js');",
  ]) {
    expect(unapprovedLegacyImports((file, text) => file.endsWith('/cli/worker-service.ts')
      ? text + '\n' + addition : text).some(edge => edge.startsWith('cli/worker-service.ts -> service/spec-builder.ts:'))).toBe(true);
  }
}, 120_000);
