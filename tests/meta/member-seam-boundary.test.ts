/**
 * Meta gate: the member seam boundary — transitive.
 *
 * A member hook may only reach the modules the spec allowlists: the hook and
 * member code itself, the extracted leaves (paths/home, project-root,
 * machine-id, capture/transcript-id, the transcript parser, the generated hook
 * config), the three utils the hooks use, constants/version, and built-ins. It
 * must not reach daemon/, service/, grove/, vault/, db/, host/, mcp/, tools/,
 * agent/, the installer, or the YAML manifest loader — and no module in its
 * closure may carry the local-daemon literals `127.0.0.1`, `daemon.json`,
 * `daemon.lock` in code. That closure is exactly what a thin member binary
 * compiles, so the gate walks the IMPORT GRAPH rather than grepping one file:
 * a forbidden import two hops deep is the same violation as a direct one.
 *
 * Two modes, one walker:
 *   - the closure of every `src/hooks/*.ts` entry (and of `src/member/**`) is
 *     REPORTED — the violation list is printed and the test passes;
 *   - the closure of each ENFORCED LEAF must sit inside the allowlist and
 *     reach no package outside `ALLOWED_EXTERNALS`, so a `grove/`, `yaml`, or
 *     workspace-package import in one of them fails by name.
 *
 * Resolution: `node:*` and `bun:*` are built-ins; `@myco/*` and every other
 * `tsconfig.json` path alias that points inside `packages/` (the workspace
 * packages) are walked and literal-scanned like source; bare npm specifiers are
 * externals — named in the report, forbidden on an enforced leaf.
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/host-transport-seam-singularity.test.ts`. Type-only imports are
 * erased at runtime and are not edges.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** Spec §4 allowlist, as paths relative to packages/myco/src (`/**` = subtree). */
const ALLOWLIST: readonly string[] = [
  'hooks/**',
  'member/**',
  'capture/buffer.ts',
  'capture/transcript-id.ts',
  'symbionts/parsers/**',
  'symbionts/adapter.ts',
  'hooks/hook-config.generated.ts',
  'paths/home.ts',
  'project-root.ts',
  'machine-id.ts',
  'utils/lifecycle-lock.ts',
  'utils/dot-path.ts',
  'utils/git.ts',
  'version.ts',
  'constants.ts',
  // constants.ts re-exports its sibling files; they are the same leaf.
  'constants/**',
];

/**
 * Bare package specifiers an enforced leaf may import. Empty: the leaves reach
 * built-ins and allowlisted source only. Widening this list is a reviewed act.
 */
const ALLOWED_EXTERNALS: readonly string[] = [];

/** Literals that name the local daemon; none may appear in code in the closure. */
const FORBIDDEN_LITERALS: readonly string[] = ['127.0.0.1', 'daemon.json', 'daemon.lock'];

/** Leaves whose closure is enforced (paths relative to packages/myco/src; `/**` = every file under). */
const ENFORCED_LEAVES: readonly string[] = [
  'paths/home.ts',
  'project-root.ts',
  'machine-id.ts',
  'capture/transcript-id.ts',
  'symbionts/parsers/**',
  'symbionts/adapter.ts',
  'hooks/hook-config.generated.ts',
  'hooks/normalize.ts',
  'hooks/response.ts',
  'hooks/input.ts',
  'hooks/capture-rules.ts',
];

// ---------------------------------------------------------------------------
// Specifier extraction
// ---------------------------------------------------------------------------

/**
 * `import … from '…'` / `export … from '…'` statements. The clause is one of:
 * default, `{ … }`, `default, { … }`, `* as ns`, or `*` (export only).
 */
const STATIC_FROM = /^[ \t]*(import|export)\s+(type\s+)?(\*\s+as\s+[\w$]+|\*|[\w$]+\s*,\s*\{[^}]*\}|\{[^}]*\}|[\w$]+)\s+from\s+['"]([^'"]+)['"]/gm;
/** `import '…'` side-effect imports. */
const SIDE_EFFECT = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
/** `import('…')` dynamic imports. */
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** True when a `{ … }` clause names only `type` members — erased at runtime. */
function braceClauseIsTypeOnly(clause: string): boolean {
  const body = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
  const members = body.split(',').map((m) => m.trim()).filter((m) => m.length > 0);
  return members.length > 0 && members.every((m) => /^type\s/.test(m));
}

/** Runtime import specifiers of one module, in source order (type-only edges dropped). */
export function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(STATIC_FROM)) {
    const [, , typeKeyword, clause, specifier] = m;
    if (typeKeyword) continue;
    if (clause.startsWith('{') && braceClauseIsTypeOnly(clause)) continue;
    out.push(specifier);
  }
  for (const m of source.matchAll(SIDE_EFFECT)) out.push(m[1]);
  for (const m of source.matchAll(DYNAMIC)) out.push(m[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface AliasTable {
  /** `@scope/*` → absolute dir (the `*` part is appended). */
  prefixes: Record<string, string>;
  /** `@scope/name` → absolute file (workspace packages mapped to one entry file). */
  exact: Record<string, string>;
}

/**
 * `compilerOptions.paths` from the root tsconfig. Prefix aliases (`@myco/*`)
 * map a subtree; exact aliases map one specifier to one file — those that
 * point inside `packages/` are workspace source and are walked; those that
 * point into `node_modules` (react, react-router, …) are installed packages
 * and stay externals.
 */
function loadAliases(): AliasTable {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf-8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  const table: AliasTable = { prefixes: {}, exact: {} };
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;
  for (const [key, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
    if (targets.length === 0) continue;
    if (key.endsWith('/*')) {
      if (!targets[0].endsWith('/*')) continue;
      table.prefixes[key.slice(0, -1)] = path.resolve(REPO_ROOT, targets[0].slice(0, -1));
      continue;
    }
    const target = path.resolve(REPO_ROOT, targets[0]);
    if (target.includes(nodeModulesSegment)) continue;
    table.exact[key] = target;
  }
  return table;
}

const ALIASES = loadAliases();

type Resolved =
  | { kind: 'builtin'; specifier: string }
  | { kind: 'external'; specifier: string }
  | { kind: 'module'; file: string };

/** Map a `.js`-suffixed (or bare) specifier to the TypeScript file on disk. */
function resolveFile(base: string): string | null {
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(fromFile: string, specifier: string): Resolved {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
    return { kind: 'builtin', specifier };
  }
  const exact = ALIASES.exact[specifier];
  if (exact) {
    const file = resolveFile(exact);
    if (!file) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable alias import ${specifier}`);
    return { kind: 'module', file };
  }
  for (const [prefix, dir] of Object.entries(ALIASES.prefixes)) {
    if (specifier.startsWith(prefix)) {
      const file = resolveFile(path.join(dir, specifier.slice(prefix.length)));
      if (!file) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable alias import ${specifier}`);
      return { kind: 'module', file };
    }
  }
  if (specifier.startsWith('.')) {
    const file = resolveFile(path.resolve(path.dirname(fromFile), specifier));
    if (!file) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable relative import ${specifier}`);
    return { kind: 'module', file };
  }
  return { kind: 'external', specifier };
}

// ---------------------------------------------------------------------------
// Closure + policy
// ---------------------------------------------------------------------------

/**
 * Display key of a module: relative to packages/myco/src for source under it,
 * repo-relative (`packages/myco-shared/…`) for workspace files outside it.
 */
function moduleKey(file: string): string {
  const rel = path.relative(SRC_ROOT, file);
  const key = rel.startsWith('..') ? path.relative(REPO_ROOT, file) : rel;
  return key.split(path.sep).join('/');
}

function matchesAllowlist(key: string): boolean {
  return ALLOWLIST.some((pattern) => (
    pattern.endsWith('/**') ? key.startsWith(pattern.slice(0, -2)) : key === pattern
  ));
}

interface Closure {
  /** Every module reached (display key → absolute file), including the entries. */
  modules: Map<string, string>;
  /** First-discovered importer of each module, for a path back to an entry. */
  via: Map<string, string | null>;
  /** Bare package specifiers reached (not walked) → first importer. */
  externals: Map<string, string>;
}

function closureOf(entries: readonly string[]): Closure {
  const modules = new Map<string, string>();
  const via = new Map<string, string | null>();
  const externals = new Map<string, string>();
  const queue: string[] = [];
  for (const entry of entries) {
    const key = moduleKey(entry);
    if (modules.has(key)) continue;
    modules.set(key, entry);
    via.set(key, null);
    queue.push(entry);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = fs.readFileSync(file, 'utf-8');
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved.kind === 'builtin') continue;
      if (resolved.kind === 'external') {
        if (!externals.has(resolved.specifier)) externals.set(resolved.specifier, moduleKey(file));
        continue;
      }
      const key = moduleKey(resolved.file);
      if (modules.has(key)) continue;
      modules.set(key, resolved.file);
      via.set(key, moduleKey(file));
      queue.push(resolved.file);
    }
  }
  return { modules, via, externals };
}

interface Violation {
  module: string;
  reason: string;
  /** Import chain from the module back to an entry, nearest importer first. */
  chain: string[];
}

function chainTo(closure: Closure, key: string): string[] {
  const chain: string[] = [];
  let cursor: string | null | undefined = closure.via.get(key);
  while (cursor) {
    chain.push(cursor);
    cursor = closure.via.get(cursor);
  }
  return chain;
}

/** Allowlist + literal violations over the walked modules. */
function moduleViolationsOf(closure: Closure): Violation[] {
  const out: Violation[] = [];
  for (const key of [...closure.modules.keys()].sort()) {
    if (!matchesAllowlist(key)) {
      out.push({ module: key, reason: 'outside allowlist', chain: chainTo(closure, key) });
    }
    const code = stripComments(fs.readFileSync(closure.modules.get(key)!, 'utf-8'));
    for (const literal of FORBIDDEN_LITERALS) {
      if (code.includes(literal)) {
        out.push({ module: key, reason: `contains literal ${literal}`, chain: chainTo(closure, key) });
      }
    }
  }
  return out;
}

/** External packages reached that are not in `ALLOWED_EXTERNALS`. */
function externalViolationsOf(closure: Closure): Violation[] {
  const out: Violation[] = [];
  for (const [specifier, importer] of [...closure.externals.entries()].sort()) {
    if (ALLOWED_EXTERNALS.includes(specifier)) continue;
    out.push({ module: specifier, reason: 'external package', chain: [importer, ...chainTo(closure, importer)] });
  }
  return out;
}

/**
 * Drop `// …` and `/* … *\/` comments, keeping string and template literals
 * intact — a literal mentioned in a comment dials nothing, one in code might.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.module} — ${v.reason}${v.chain.length > 0 ? `  (via ${v.chain.join(' <- ')})` : ''}`)
    .join('\n');
}

function listTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

function expandLeaf(pattern: string): string[] {
  if (pattern.endsWith('/**')) return listTs(path.join(SRC_ROOT, pattern.slice(0, -3)));
  return [path.join(SRC_ROOT, pattern)];
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe('member seam boundary (transitive)', () => {
  const hookEntries = listTs(path.join(SRC_ROOT, 'hooks')).filter((f) => path.dirname(f) === path.join(SRC_ROOT, 'hooks'));
  const memberEntries = listTs(path.join(SRC_ROOT, 'member'));

  it('walks every hooks/ and member/ entry and reports the closure outside the allowlist (report mode)', () => {
    expect(hookEntries.length).toBeGreaterThan(0);
    const closure = closureOf([...hookEntries, ...memberEntries]);
    const violations = [...moduleViolationsOf(closure), ...externalViolationsOf(closure)];
    const outside = new Set(violations.filter((v) => v.reason === 'outside allowlist').map((v) => v.module));
    const literals = violations.filter((v) => v.reason.startsWith('contains literal'));
    const externals = violations.filter((v) => v.reason === 'external package');
    // REPORT MODE: the hooks closure is printed, not asserted — the list is
    // what the member rewiring clears before this block becomes an assertion.
    console.log(
      `[member-seam] report: ${closure.modules.size} modules in the hooks closure, `
      + `${outside.size} outside the allowlist, ${literals.length} forbidden-literal hits, `
      + `${externals.length} external packages reached\n`
      + formatViolations(violations),
    );
    expect(Array.isArray(violations)).toBe(true);
  });

  for (const leaf of ENFORCED_LEAVES) {
    it(`enforces the closure of ${leaf} inside the allowlist`, () => {
      const files = expandLeaf(leaf);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(fs.existsSync(file)).toBe(true);
        const closure = closureOf([file]);
        const violations = [...moduleViolationsOf(closure), ...externalViolationsOf(closure)];
        if (violations.length > 0) {
          throw new Error(`${moduleKey(file)} reaches outside the member seam allowlist:\n${formatViolations(violations)}`);
        }
        expect(violations).toEqual([]);
      }
    });
  }

  it('resolves @myco/* and the workspace packages through the root tsconfig', () => {
    expect(ALIASES.prefixes['@myco/']).toBe(path.join(REPO_ROOT, 'packages', 'myco', 'src'));
    expect(ALIASES.exact['@goondocks/myco-shared']).toBe(path.join(REPO_ROOT, 'packages', 'myco-shared', 'src', 'index.ts'));
    expect(ALIASES.exact.react).toBeUndefined();
  });

  it('scans literals in code, not in comments', () => {
    expect(stripComments("// daemon.json\nconst a = 1; /* 127.0.0.1 */\nconst b = 'x';")).not.toContain('daemon.json');
    expect(stripComments("const url = 'http://127.0.0.1';")).toContain('127.0.0.1');
    expect(stripComments('const t = `see // not a comment`;')).toContain('not a comment');
  });

  it('drops type-only imports and keeps runtime ones', () => {
    const sample = [
      "import type { A } from './a.js';",
      "import { type B, type C } from './b.js';",
      "import { type D, e } from './d.js';",
      "import f from './f.js';",
      "export * from './g.js';",
      "export type { H } from './h.js';",
      "import './i.js';",
      "const j = await import('./j.js');",
    ].join('\n');
    expect(runtimeSpecifiers(sample)).toEqual(['./d.js', './f.js', './g.js', './i.js', './j.js']);
  });
});
