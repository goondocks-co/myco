import { expect, it } from 'bun:test';
import fs from 'node:fs';
import ts from 'typescript-v6';
import { codeOf } from '../helpers/import-closure.ts';
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
