import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { REPO_ROOT } from '../helpers/import-closure.ts';

/** Command selection belongs to the registry, including flags and hidden entries. */
function dispatchViolations(source: string, member = false): string[] {
  const tree = ts.createSourceFile('dispatcher.ts', source, ts.ScriptTarget.Latest, true);
  const scope = member ? tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'run') : tree;
  if (!scope) return ['missing member run'];
  const selector = member ? 'op' : 'cmd';
  const found: string[] = [];
  const identifier = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === selector;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      if ((identifier(node.left) && ts.isStringLiteralLike(node.right)) || (identifier(node.right) && ts.isStringLiteralLike(node.left))) found.push('literal command comparison');
    }
    if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)) found.push('literal case dispatch');
    if (member && ts.isElementAccessExpression(node) && identifier(node.argumentExpression) && node.expression.getText(tree) !== 'MEMBER_COMMANDS') found.push('member lookup outside registry');
    if (member && ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      const allowed = ['Object.hasOwn', 'command.run', 'MEMBER_HELP.trimEnd', '(deps.stderr ?? console.error)'];
      if (!allowed.includes(callee)) found.push('member call outside registry: ' + callee);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  if (member && !scope.getText(tree).includes('MEMBER_COMMANDS[op]')) found.push('missing member registry lookup');
  return found;
}

const cli = fs.readFileSync(path.join(REPO_ROOT, 'packages/myco/src/cli.ts'), 'utf8');
const member = fs.readFileSync(path.join(REPO_ROOT, 'packages/myco/src/cli/member.ts'), 'utf8');

it('dispatches top-level and member commands only through their registrations', () => {
  expect(dispatchViolations(cli)).toEqual([]);
  expect(dispatchViolations(member, true)).toEqual([]);
});

it('rejects M2, a literal command branch beside the top-level registry', () => {
  expect(dispatchViolations(cli.replace('  if (isRetiredVerb(cmd))', "  if (cmd === 'sneaky') return;\n  if (isRetiredVerb(cmd))"))).toContain('literal command comparison');
});

it('rejects M3, a literal member branch beside MEMBER_COMMANDS', () => {
  expect(dispatchViolations(member.replace('  const [op, ...rest] = args;', "  const [op, ...rest] = args;\n  if (op === 'sneaky') return;"), true)).toContain('literal command comparison');
});

it('rejects switch dispatch and direct member handler calls', () => {
  expect(dispatchViolations(cli + "\nswitch (cmd) { case 'sneaky': break; }" )).toContain('literal case dispatch');
  expect(dispatchViolations(member.replace('  const [op, ...rest] = args;', '  const [op, ...rest] = args;\n  runSneaky(rest, deps);'), true)).toContain('member call outside registry: runSneaky');
});
