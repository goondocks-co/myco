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
 * Edges and comment-free code come from the runtime's own parser, never a
 * hand-rolled lexer: `Bun.Transpiler.scanImports` lists every specifier the
 * transpiled module still imports (static, `export … from`, side-effect,
 * literal `import()` / `require()`), so an import the transpiler elides — a
 * type-only import — is not an edge, and everything else is; `transformSync`
 * yields the module's code without comments (regex- and string-aware) for the
 * literal scan. The transpiler runs with dead-code elimination OFF, so a
 * literal behind `false ? … : …`, `x && …`, or an env-gated branch is scanned
 * like any other — the compiled binary carries whatever the build machine's
 * environment selects. A non-literal `import(expr)` / `require(expr)` names
 * no module the gate can follow; each one is reported as an unknowable
 * dynamic import and is a violation on an enforced leaf. A `.json` module is
 * a leaf: no edges, its raw text is literal-scanned.
 *
 * Resolution: `node:*` and `bun:*` are built-ins; `@myco/*` and every other
 * `tsconfig.json` path alias that points inside `packages/` (the workspace
 * packages) are walked and literal-scanned like source; bare npm specifiers are
 * externals — named in the report, forbidden on an enforced leaf.
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/host-transport-seam-singularity.test.ts`.
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
// Specifier extraction — the runtime's parser
// ---------------------------------------------------------------------------

type Loader = 'ts' | 'tsx' | 'js' | 'jsx';

const LOADER_BY_EXT: Record<string, Loader> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
};

// A `.tsx` module registers the JSX runtime (`react`, `react/jsx-dev-runtime`)
// as externals through the transpiler's auto-import; no tsx module is in the
// hooks closure today.
const transpilers = new Map<Loader, InstanceType<typeof Bun.Transpiler>>();

function transpilerFor(file: string): InstanceType<typeof Bun.Transpiler> {
  const loader = LOADER_BY_EXT[path.extname(file)] ?? 'ts';
  let t = transpilers.get(loader);
  if (!t) {
    t = new Bun.Transpiler({ loader, deadCodeElimination: false });
    transpilers.set(loader, t);
  }
  return t;
}

function isJsonModule(file: string): boolean {
  return path.extname(file) === '.json';
}

/** What the transpiler reports for one module. */
export interface RuntimeEdges {
  /** Every specifier the transpiled module imports, in source order. */
  specifiers: string[];
  /** `import(expr)` / `require(expr)` call sites whose specifier is not a literal — modules the gate cannot follow. */
  unknowableDynamic: number;
}

const DYNAMIC_IMPORT_CALL = /\bimport\s*\(/g;
const REQUIRE_CALL = /(?<![.\w$])require\s*\(/g;

/**
 * Edges of one module. Type-only imports are elided by the transpiler and
 * therefore absent; static imports, `export … from`, side-effect imports,
 * literal `import()` and `require()` are present. Dynamic call sites the
 * transpiler could not resolve to a literal are counted, not guessed.
 */
export function runtimeEdges(source: string, file = 'module.ts'): RuntimeEdges {
  if (isJsonModule(file)) return { specifiers: [], unknowableDynamic: 0 };
  const transpiler = transpilerFor(file);
  const entries = transpiler.scanImports(source);
  const code = transpiler.transformSync(source);
  const literalDynamic = entries.filter((e) => e.kind === 'dynamic-import' || e.kind === 'require-call').length;
  const callSites = (code.match(DYNAMIC_IMPORT_CALL)?.length ?? 0) + (code.match(REQUIRE_CALL)?.length ?? 0);
  return {
    specifiers: entries.map((entry) => entry.path),
    unknowableDynamic: Math.max(0, callSites - literalDynamic),
  };
}

/** The module's code with comments removed by the transpiler (regex- and string-aware); JSON is scanned raw. */
export function codeOf(source: string, file = 'module.ts'): string {
  if (isJsonModule(file)) return source;
  return transpilerFor(file).transformSync(source);
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
  /** Modules with `import(expr)` / `require(expr)` call sites the gate cannot follow → count. */
  unknowable: Map<string, number>;
}

function closureOf(entries: readonly string[]): Closure {
  const modules = new Map<string, string>();
  const via = new Map<string, string | null>();
  const externals = new Map<string, string>();
  const unknowable = new Map<string, number>();
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
    const edges = runtimeEdges(source, file);
    if (edges.unknowableDynamic > 0) unknowable.set(moduleKey(file), edges.unknowableDynamic);
    for (const specifier of edges.specifiers) {
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
  return { modules, via, externals, unknowable };
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
    const file = closure.modules.get(key)!;
    const code = codeOf(fs.readFileSync(file, 'utf-8'), file);
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

/** Dynamic call sites whose target the gate cannot follow. */
function unknowableViolationsOf(closure: Closure): Violation[] {
  const out: Violation[] = [];
  for (const [key, count] of [...closure.unknowable.entries()].sort()) {
    out.push({ module: key, reason: `unknowable dynamic import (${count})`, chain: chainTo(closure, key) });
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
    const violations = [...moduleViolationsOf(closure), ...externalViolationsOf(closure), ...unknowableViolationsOf(closure)];
    const outside = new Set(violations.filter((v) => v.reason === 'outside allowlist').map((v) => v.module));
    const literals = violations.filter((v) => v.reason.startsWith('contains literal'));
    const externals = violations.filter((v) => v.reason === 'external package');
    const unknowable = violations.filter((v) => v.reason.startsWith('unknowable dynamic import'));
    // REPORT MODE: the hooks closure is printed, not asserted — the list is
    // what the member rewiring clears before this block becomes an assertion.
    console.log(
      `[member-seam] report: ${closure.modules.size} modules in the hooks closure, `
      + `${outside.size} outside the allowlist, ${literals.length} forbidden-literal hits, `
      + `${externals.length} external packages reached, ${unknowable.length} modules with unknowable dynamic imports\n`
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
        const violations = [...moduleViolationsOf(closure), ...externalViolationsOf(closure), ...unknowableViolationsOf(closure)];
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

  it('scans literals in code, not in comments — regex- and string-aware, dead code included', () => {
    expect(codeOf("// daemon.json\nconst a = 1; /* 127.0.0.1 */\nexport const b = 'x';")).not.toContain('daemon.json');
    expect(codeOf("export const url = 'http://127.0.0.1';")).toContain('127.0.0.1');
    expect(codeOf('export const t = `see // not a comment`;')).toContain('not a comment');
    expect(codeOf("export const Q = /'/;\nexport const H = 'http://' + '127.0.0.1';")).toContain('127.0.0.1');
    expect(codeOf("export const R = /[//]/; export const H2 = 'daemon.json';")).toContain('daemon.json');
    expect(codeOf("export const a = false ? 'daemon.lock' : '';")).toContain('daemon.lock');
    expect(codeOf("export const b = process.env.NODE_ENV === 'production' ? 'daemon.lock' : '';")).toContain('daemon.lock');
    expect(codeOf('{"name":"x","state":"daemon.json"}', 'package.json')).toContain('daemon.json');
  });

  it('treats a JSON module as a leaf and counts dynamic imports it cannot follow', () => {
    expect(runtimeEdges('{"name":"x","dependencies":{"yaml":"1"}}', 'package.json')).toEqual({ specifiers: [], unknowableDynamic: 0 });
    expect(runtimeEdges("export const load = (spec: string) => import(spec);")).toEqual({ specifiers: [], unknowableDynamic: 1 });
    expect(runtimeEdges("export const load = (spec: string) => require(spec); export const r = require.resolve('x');")).toEqual({ specifiers: [], unknowableDynamic: 1 });
    expect(runtimeEdges("export const j = () => import('./j.js');")).toEqual({ specifiers: ['./j.js'], unknowableDynamic: 0 });
  });

  it('takes edges from the transpiler: type-only imports are elided, every other form is seen', () => {
    const sample = [
      "import type { A } from './a.js';",
      "import { type B, type C } from './b.js';",
      "import { type D, e } from './d.js';",
      "import f from './f.js';",
      "import dc, * as ns from './dcns.js';",
      "export * from './g.js';",
      "export type { H } from './h.js';",
      "import './i.js';",
      "const j = await import('./j.js');",
      "const k = await import(`./k.js`);",
      "const l = await import(/* c */ './l.js');",
      "void e; void f; void dc; void ns; void j; void k; void l;",
    ].join('\n');
    expect(runtimeEdges(sample)).toEqual({
      specifiers: ['./d.js', './f.js', './dcns.js', './g.js', './i.js', './j.js', './k.js', './l.js'],
      unknowableDynamic: 0,
    });
  });
});
