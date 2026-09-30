/**
 * Meta gate: a member never applies a Deployment leaf it is answered (#1541), by what its code can name.
 *
 * `tests/cli/member-settings-leaves.test.ts` proves the behaviour: every leaf served carries a sentinel, and the two
 * readers of `POST /members/settings` leave none of them in the environment or on disk. This gate holds the code to
 * the shape that proof relies on, read with the TypeScript parser rather than by line:
 *
 *   1. No module the member runs but the two readers (`cli/member-config.ts`, `member/machine-settings.ts`) can build
 *      the route: every string expression is folded, literals, `+`, templates and constants named across modules
 *      alike, and none but theirs comes to `/members/settings`.
 *   2. No module in the member's import closure, the two readers aside, names a Deployment leaf, retired or not: a
 *      module that named one could apply it. The Deployment's own modules in the closure read their leaves as the
 *      Deployment, and two 1.4 modules name the 1.4 keys a leaf shares a name with (`COINCIDENT`).
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript-v6';
import { DEPLOYMENT_LEAVES, RETIRED_LEAVES } from '@myco-server-worker/core/settings.js';
import { closureOf, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';

const ROUTE = '/members/settings';
const READERS = ['packages/myco/src/cli/member-config.ts', 'packages/myco/src/member/machine-settings.ts'];
/** The code the member runs, as opposed to the Deployment's own that its binary also carries. */
const MEMBER_TREES = ['packages/myco/src', 'packages/myco-shared/src', 'packages/myco-team/worker/src'];
/** The entries the 2.0 member runs through: its verbs, its sign-in, and its capture hooks. */
const ENTRIES = ['cli/member-dispatch.ts', 'cli/member-reads.ts', 'cli/login.ts', 'hooks/session-start.ts', 'hooks/user-prompt-submit.ts', 'hooks/stop.ts', 'hooks/session-end.ts']
  .map((file) => path.join(REPO_ROOT, 'packages/myco/src', file));
/** Modules that name a string a Deployment leaf shares, for a reason of their own, and exactly those strings. */
const COINCIDENT: Readonly<Record<string, readonly string[]>> = {
  // A log kind, the name of an event the member's log records.
  'packages/myco/src/constants/log-kinds.ts': ['embedding.provider'],
  // The 1.4 configuration's tiers, read from the 1.4 config files and never from a Deployment answer.
  'packages/myco/src/config/scope.ts': ['agent.event_tasks_enabled', 'agent.run_retention_days', 'agent.scheduled_tasks_enabled', 'agent.semantic_write_check_enabled', 'release_provenance.reconcile_interval_minutes'],
};

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const memberSources = (): string[] => MEMBER_TREES.flatMap((tree) => filesUnder(path.join(REPO_ROOT, tree)))
  .filter((file) => /\.tsx?$/.test(file) && !/\.generated\.ts$/.test(file) && !/\.d\.ts$/.test(file));

/** Top-level string constants of every member module, by name: what a folded expression may name across modules. */
function constants(files: readonly ts.SourceFile[]): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  let changed = true;
  // A constant may be built from another, so the table is folded until it stops growing.
  while (changed) {
    changed = false;
    for (const file of files) {
      for (const statement of file.statements) {
        if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
          for (const value of fold(declaration.initializer, found)) {
            const held = found.get(declaration.name.text) ?? new Set<string>();
            if (!held.has(value)) { held.add(value); found.set(declaration.name.text, held); changed = true; }
          }
        }
      }
    }
  }
  return found;
}

/** Every string an expression can come to from literals, `+`, templates and named constants; none for anything else. */
function fold(node: ts.Node, named: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return fold(node.expression, named);
  if (ts.isIdentifier(node)) return [...(named.get(node.text) ?? [])];
  if (ts.isPropertyAccessExpression(node)) return [...(named.get(node.name.text) ?? [])];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = fold(node.left, named);
    const right = fold(node.right, named);
    return left.flatMap((l) => right.map((r) => l + r));
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const parts = fold(span.expression, named);
      if (parts.length === 0) return [];
      values = values.flatMap((v) => parts.map((p) => v + p + span.literal.text));
    }
    return values;
  }
  return [];
}

/** Every node of `file` for which `test` holds. */
function nodes(file: ts.SourceFile, test: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node): void => { if (test(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(file);
  return found;
}

const isStringExpression = (node: ts.Node): boolean =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)
  || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);

describe('a member and the Deployment leaves it is answered', () => {
  const sources = memberSources().map(parse);
  const named = constants(sources);

  it('builds the settings route in its two readers alone, however the string is put together', () => {
    expect(sources.length).toBeGreaterThan(100);
    const building = sources.filter((file) => nodes(file, isStringExpression).some((node) => fold(node, named).some((value) => value.includes(ROUTE))))
      .map((file) => moduleKey(file.fileName)).sort();
    expect(building).toEqual([...READERS].sort());
  });

  it('names no Deployment leaf, retired or not, in a module of its own closure but the two readers', () => {
    const closure = closureOf(ENTRIES);
    const modules = [...closure.modules.keys()].map((file) => moduleKey(path.isAbsolute(file) ? file : path.join(REPO_ROOT, file)))
      .filter((key) => MEMBER_TREES.some((tree) => key.startsWith(`${tree}/`)) && /\.tsx?$/.test(key));
    expect(modules.length).toBeGreaterThan(100);
    for (const reader of READERS) expect({ reader, inClosure: modules.includes(reader) }).toEqual({ reader, inClosure: true });
    const leaves = new Set(DEPLOYMENT_LEAVES);
    const naming: Record<string, string[]> = {};
    for (const key of modules) {
      if (READERS.includes(key)) continue;
      const file = parse(path.join(REPO_ROOT, key));
      const names = [...new Set(nodes(file, (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        .map((node) => (node as ts.StringLiteral).text).filter((text) => leaves.has(text)))].sort();
      const unexplained = names.filter((name) => !(COINCIDENT[key] ?? []).includes(name)).map((name) => (RETIRED_LEAVES.has(name) ? `${name} (retired)` : name));
      if (unexplained.length > 0) naming[key] = unexplained;
    }
    expect(naming).toEqual({});
    // Each coincidence is still there: one that goes leaves the list.
    for (const [key, names] of Object.entries(COINCIDENT)) {
      const file = parse(path.join(REPO_ROOT, key));
      const held = new Set(nodes(file, (node) => ts.isStringLiteral(node)).map((node) => (node as ts.StringLiteral).text));
      expect({ key, missing: names.filter((name) => !held.has(name)), inClosure: modules.includes(key) }).toEqual({ key, missing: [], inClosure: true });
    }
  });
});
