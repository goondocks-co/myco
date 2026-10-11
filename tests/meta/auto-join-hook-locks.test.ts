import { expect, it } from 'bun:test';
import path from 'node:path';
import ts from 'typescript-v6';

const SRC = path.resolve(import.meta.dir, '../../packages/myco/src');
const ENTRY = path.join(SRC, 'member/auto-join-hook.ts');
const REPO = path.resolve(SRC, '../../..');
const config = ts.readConfigFile(path.join(REPO, 'tsconfig.json'), ts.sys.readFile);
if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, REPO);
if (options.errors.length > 0) throw new Error(options.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
const program = ts.createProgram([ENTRY], options.options);
const checker = program.getTypeChecker();

function declaration(file: string, name: string): ts.FunctionDeclaration {
  const found = program.getSourceFile(path.join(SRC, file))?.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (found === undefined) throw new Error(`Missing hook function ${file}:${name}`);
  return found;
}

/** Compiler-resolved call edges include aliases, nested callbacks and workspace imports. */
function blockingPaths(entry: ts.FunctionDeclaration, forbidProcesses = false): string[] {
  const paths = new Set<string>();
  const walk = (fn: ts.SignatureDeclaration, chain: string[], ancestors: ReadonlySet<ts.Node>): void => {
    if (ancestors.has(fn)) return;
    const nextAncestors = new Set([...ancestors, fn]);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const target = checker.getResolvedSignature(node)?.declaration;
        if (forbidProcesses && target?.getSourceFile().fileName.endsWith('/child_process.d.ts')) {
          paths.add([...chain, node.expression.getText()].join(' → '));
        }
        if (target !== undefined && !ts.isJSDocSignature(target) && target.getSourceFile().fileName.startsWith(`${SRC}${path.sep}`)) {
          const name = target.name?.getText() ?? '<anonymous>';
          const next = [...chain, name];
          if (name === 'withRegistryLock') {
            paths.add(next.join(' → '));
          } else if (name === 'withFileLockSync') {
            // Sync-only file locks serialize local file work; registry holders can await network I/O.
            return;
          } else if (name === 'acquire' && target.getSourceFile().fileName === path.join(SRC, 'utils/lifecycle-lock.ts')) {
            const options = node.arguments?.[1];
            const nonblocking = options === undefined || (ts.isObjectLiteralExpression(options) && options.properties.every(
              (property) => ts.isPropertyAssignment(property) && (property.name.getText() !== 'wait' || property.initializer.kind === ts.SyntaxKind.FalseKeyword),
            ));
            if (!nonblocking) paths.add([...next, 'wait option is not statically false'].join(' → '));
          } else {
            walk(target, next, nextAncestors);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const parameter of fn.parameters) {
      if (parameter.initializer === undefined) continue;
      const symbol = checker.getSymbolAtLocation(parameter.initializer);
      const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declared of target?.declarations ?? []) {
        if (ts.isFunctionDeclaration(declared)) walk(declared, [...chain, declared.name?.text ?? '<default>'], nextAncestors);
      }
    }
    if ('body' in fn && fn.body !== undefined) visit(fn.body);
  };
  walk(entry, [entry.name?.text ?? '<anonymous>'], new Set());
  return [...paths].sort();
}

it('the hook opt-out decision cannot wait on a lock held across I/O', () => {
  expect(blockingPaths(declaration('member/auto-join.ts', 'joinStanding'))).toEqual([]);
});

it('hook repository resolution and eligibility cannot start Git or wait for a registry lock', () => {
  for (const [file, name] of [
    ['member/credential.ts', 'resolveMemberProjectRoot'],
    ['member/auto-join.ts', 'silentRepository'],
  ]) expect(blockingPaths(declaration(file, name), true)).toEqual([]);
});
