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
  const verdictSites = new Map<ts.SignatureDeclaration, Set<ts.Node>>();
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
          const query = node.arguments?.[0];
          const verdictCall = name === 'runGitAnswer' && query !== undefined && ts.isArrayLiteralExpression(query)
            && ((chain.at(-1) === 'gitRepositoryRoot' && query.elements.map((e) => e.getText()).join(',') === "'rev-parse','--show-toplevel','--git-dir','--git-common-dir'")
              || (chain.at(-1) === 'isSafeProjectRoot' && query.elements.map((e) => e.getText()).join(',') === "'rev-parse','--git-common-dir'"));
          const cachedVerdict = name === 'runGitAnswer' && chain.at(-1) === 'repoVerdict'
            && node.getSourceFile().fileName === path.join(SRC, 'member/git-verdict.ts') && query?.getText() === 'VERDICT_QUERY';
          if (forbidProcesses && (verdictCall || cachedVerdict)) {
            const sites = verdictSites.get(fn) ?? new Set<ts.Node>();
            sites.add(node);
            verdictSites.set(fn, sites);
            if (sites.size > 1) paths.add([...chain, 'more than one repository verdict call'].join(' → '));
            return;
          }
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

it('hook repository resolution and eligibility can only ask the established Git verdict and cannot wait for a registry lock', () => {
  for (const [file, name] of [
    ['member/credential.ts', 'resolveMemberProjectRoot'],
    ['member/auto-join.ts', 'silentRepository'],
  ]) expect(blockingPaths(declaration(file, name), true)).toEqual([]);
});

it('the cached Git boundary asks only the repository verdict', () => {
  const source = program.getSourceFile(path.join(SRC, 'member/git-verdict.ts'))!;
  expect(source.text).toContain("const VERDICT_QUERY = ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'];");
});
