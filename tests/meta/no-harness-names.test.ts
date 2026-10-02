/**
 * Gate G7 (#1561): one code path for every harness. Where harnesses differ, the difference is data in a manifest
 * (`symbionts/manifests/*.yaml`), read by shared code; no code outside the registries that exist to be per-harness
 * names a harness.
 *
 * Read from each file's syntax tree (TypeScript's own parser, `typescript/unstable/async`), so comments never count and
 * every way of writing a name does. A harness is named by:
 * - a string literal equal to its manifest name, wherever it stands: compared, switched on, passed (`.includes`,
 *   `Set.has`, `startsWith`), bound to a constant, used as a key (`cfg['codex']`, `{ 'claude-code': … }`) or as a
 *   literal type;
 * - a template literal whose text holds the name where a substitution or a path joins it (`` `${dir}/codex` ``);
 * - an identifier key of an object literal keyed by two harness names or more (a per-harness map);
 * - a string naming its environment variables (a prefix its `pluginRootEnvVar` declares, such as `CLAUDE_`) or its
 *   configuration directory (its `configDir`, such as `.claude`).
 * A string that names a key, not a harness, is not flagged: a query parameter's name (`searchParams.get('cursor')`)
 * or a key picked from a type (`Pick<T, 'cursor'>`).
 *
 * In scope: the 2.0 member closure (what the hooks, the member seam, the worker and the member verbs reach), and the
 * shared and Deployment packages whole. Allowed to name harnesses: the registries that exist to be per-harness.
 *
 * KNOWN is a ratchet: today's offenders, by file and count. It may only shrink: what is left is the worker's harness
 * facts, which the manifests' `runner:` block takes (#1561), and then it is empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import path from 'node:path';
import { API } from 'typescript/unstable/async';
import { skipTrivia, SyntaxKind, type Node, type SourceFile } from 'typescript/unstable/ast';
import { closureOf, entryFiles, filesUnder, moduleKey, REPO_ROOT } from '../helpers/import-closure.ts';
import { BUNDLED_MANIFESTS } from '@myco/symbionts/manifests.generated.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const MEMBER_ENTRIES = ['hooks/**', 'member/**', 'runner/**', 'cli/member-dispatch.ts', 'cli/member-verbs.ts'];
const WHOLE_PACKAGES = [path.join(REPO_ROOT, 'packages', 'myco-shared', 'src'), path.join(REPO_ROOT, 'packages', 'myco-server', 'src')];

/** The registries that exist to be per-harness: transcript adapters and parsers, plugin host templates, worker drivers, and the manifest data and its loader. */
const REGISTRIES: readonly RegExp[] = [
  /^packages\/myco-shared\/src\/execution-profile\.ts$/,
  /^packages\/myco\/src\/symbionts\/(claude-code|codex|cursor|copilot|windsurf|antigravity)\.ts$/,
  /^packages\/myco\/src\/symbionts\/parsers\//,
  /^packages\/myco\/src\/symbionts\/templates\//,
  /^packages\/myco\/src\/symbionts\/(registry|detect|manifest-schema)\.ts$/,
  /^packages\/myco\/src\/runner\/drivers\//,
  /^packages\/myco\/src\/runner\/harnesses\.ts$/,
  /^packages\/myco-server\/src\/ingest\/parsers\//,
  /\.generated\.ts$/,
];

/** Today's offenders: file → how many places name a harness. Only shrinks; the `runner:` block (#1561) folds what is left. */
const KNOWN: Readonly<Record<string, number>> = {
  'packages/myco-shared/src/harness-providers.ts': 7,
  // The worker's credential slot named for a harness (`codex`): the manifest's `runner:` block.
  'packages/myco-shared/src/secret-slots.ts': 2,
};

const NAMES = new Set(BUNDLED_MANIFESTS.map((m) => m.name));
const ENV_PREFIXES = Object.values(HOOK_CONFIG).map((c) => (c as { pluginRootEnvVar?: string }).pluginRootEnvVar)
  .filter((v): v is string => typeof v === 'string' && v.endsWith('_PLUGIN_ROOT'))
  .map((v) => v.slice(0, -'PLUGIN_ROOT'.length));
const CONFIG_DIRS = Object.values(HOOK_CONFIG).map((c) => (c as { configDir?: string }).configDir)
  .filter((v): v is string => typeof v === 'string' && v.startsWith('.'));

function inScope(): string[] {
  const closure = closureOf(entryFiles(SRC, MEMBER_ENTRIES));
  const files = new Set([...closure.modules.values()].filter((f) => /\.tsx?$/.test(f)));
  for (const dir of WHOLE_PACKAGES) for (const f of filesUnder(dir)) files.add(f);
  return [...files].filter((f) => !REGISTRIES.some((r) => r.test(moduleKey(f)))).sort();
}

/** A regular-expression source matching any of these strings exactly. */
const anyOf = (values: Iterable<string>): string => [...values].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/**
 * A harness name in a template's text: at either end of a piece, where a substitution joins it (`` `codex resume ${id}` ``,
 * `` `${bin} --symbiont codex` ``), or between path and key delimiters (`` `${dir}/.codex/config` ``). A name inside a
 * sentence (`` `no line count for cursor ${n}` ``) is prose, not a harness.
 */
const DELIMITER = `[/\\\\.=:'"]`;
const NAME_IN_TEMPLATE = new RegExp([
  `^(?:${anyOf(NAMES)})(?=$|\\s|${DELIMITER})`,
  `(?:^|\\s|${DELIMITER})(?:${anyOf(NAMES)})$`,
  `${DELIMITER}(?:${anyOf(NAMES)})${DELIMITER}`,
].join('|'));
const CONFIG_DIR = new RegExp(`(?:^|[/~])(?:${anyOf(CONFIG_DIRS)})(?:/|$)`);
const QUERY_PARAMETER_METHODS = new Set(['get', 'getAll', 'has', 'set', 'append', 'delete']);

const isStringish = (kind: SyntaxKind): boolean => kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
const isTemplatePiece = (kind: SyntaxKind): boolean =>
  kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle || kind === SyntaxKind.TemplateTail || kind === SyntaxKind.NoSubstitutionTemplateLiteral;
const textOf = (node: Node): string => (node as unknown as { text: string }).text;
const nameText = (node: Node | undefined): string | undefined =>
  node !== undefined && (node.kind === SyntaxKind.Identifier || isStringish(node.kind)) ? textOf(node) : undefined;

/** A string that names a key, not a harness: a query parameter's name, or a key picked from a type. */
function namesAKey(literal: Node): boolean {
  const parent = literal.parent;
  if (parent?.kind === SyntaxKind.CallExpression) {
    const call = parent as unknown as { expression: Node; arguments: readonly Node[] };
    if (call.arguments[0] !== literal || call.expression.kind !== SyntaxKind.PropertyAccessExpression) return false;
    const access = call.expression as unknown as { expression: Node; name: Node };
    const receiver = access.expression.kind === SyntaxKind.PropertyAccessExpression ? (access.expression as unknown as { name: Node }).name : access.expression;
    return QUERY_PARAMETER_METHODS.has(textOf(access.name)) && nameText(receiver) === 'searchParams';
  }
  if (parent?.kind === SyntaxKind.LiteralType) {
    let up: Node | undefined = parent.parent;
    while (up?.kind === SyntaxKind.UnionType) up = up.parent;
    const typeName = up?.kind === SyntaxKind.TypeReference ? nameText((up as unknown as { typeName: Node }).typeName) : undefined;
    return typeName === 'Pick' || typeName === 'Omit';
  }
  return false;
}

/** The harness names an object literal's own keys spell, identifier and string keys alike. */
function harnessKeys(object: Node): Node[] {
  const keys: Node[] = [];
  for (const property of (object as unknown as { properties: readonly Node[] }).properties) {
    const name = (property as unknown as { name?: Node }).name;
    const text = nameText(name);
    if (name !== undefined && text !== undefined && NAMES.has(text)) keys.push(name);
  }
  return keys;
}

/** Every place a file names a harness, as `line: kind text`, read from its syntax tree. */
function namings(sf: SourceFile): string[] {
  const text = sf.text;
  const lineOf = (node: Node): number => text.slice(0, skipTrivia(text, node.pos)).split('\n').length;
  const found: string[] = [];
  const visit = (node: Node): void => {
    const kind = node.kind;
    if (isStringish(kind) || isTemplatePiece(kind)) {
      const value = textOf(node);
      if (isStringish(kind) && NAMES.has(value) && !namesAKey(node)) found.push(`${lineOf(node)}: string "${value}"`);
      else if (isTemplatePiece(kind) && NAME_IN_TEMPLATE.test(value)) found.push(`${lineOf(node)}: template "${value}"`);
      if (/^[A-Z0-9_]+$/.test(value) && ENV_PREFIXES.some((prefix) => value.startsWith(prefix))) found.push(`${lineOf(node)}: environment "${value}"`);
      if (CONFIG_DIR.test(value)) found.push(`${lineOf(node)}: directory "${value}"`);
    }
    // A key is a harness only in a per-harness map, one keyed by two harnesses or more: a lone `cursor` key is a page
    // cursor. A string key is a string above already.
    if (kind === SyntaxKind.ObjectLiteralExpression) {
      const keys = harnessKeys(node);
      if (new Set(keys.map(textOf)).size >= 2) for (const key of keys) if (key.kind === SyntaxKind.Identifier) found.push(`${lineOf(key)}: key ${textOf(key)}`);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

/** The syntax tree of every file, from the projects that compile them. */
async function syntaxTrees(files: readonly string[]): Promise<Map<string, SourceFile>> {
  const api = new API({ cwd: REPO_ROOT });
  try {
    const configs = ['tsconfig.json', 'packages/myco-server/tsconfig.json', 'packages/myco-shared/tsconfig.json'].map((c) => path.join(REPO_ROOT, c));
    const snapshot = await api.updateSnapshot({ openProjects: configs });
    const trees = new Map<string, SourceFile>();
    for (const file of files) {
      const project = await snapshot.getDefaultProjectForFile(file);
      const tree = project === undefined ? undefined : await project.program.getSourceFile(file);
      if (tree !== undefined) trees.set(file, tree);
    }
    return trees;
  } finally {
    await api.close();
  }
}

describe('no code names a harness outside the registries (G7)', () => {
  const files = inScope();
  const offenders: Record<string, string[]> = {};
  let trees = new Map<string, SourceFile>();
  beforeAll(async () => {
    trees = await syntaxTrees(files);
    for (const [file, tree] of trees) {
      const hits = namings(tree);
      if (hits.length > 0) offenders[moduleKey(file)] = hits;
    }
  }, 60_000);
  afterAll(() => trees.clear());

  it('reads the harnesses, their environment prefixes and their configuration directories from manifest data', () => {
    expect(NAMES.size).toBeGreaterThanOrEqual(9);
    expect(ENV_PREFIXES).toContain('CLAUDE_');
    expect(CONFIG_DIRS).toContain('.claude');
    expect(files.length).toBeGreaterThan(100);
    // Every file in scope was parsed: none is missing from the projects that compile it.
    expect(files.filter((file) => !trees.has(file)).map(moduleKey)).toEqual([]);
  });

  it('finds no file naming a harness beyond the known ones, and no known file naming more than it did', () => {
    const grown = Object.entries(offenders)
      .filter(([file, hits]) => hits.length > (KNOWN[file] ?? 0))
      .map(([file, hits]) => `${file} (${hits.length}, known ${KNOWN[file] ?? 0}):\n  ${hits.join('\n  ')}`);
    expect(grown).toEqual([]);
  });

  it('shrinks: a known file that names fewer harnesses now is lowered, and one that names none is removed', () => {
    const stale = Object.entries(KNOWN).filter(([file, count]) => (offenders[file]?.length ?? 0) < count).map(([file]) => file);
    expect(stale).toEqual([]);
  });
});
