/**
 * The import closure of a set of entry modules, as the runtime's own parser
 * sees it.
 *
 * A gate that greps one file proves nothing about what that file pulls in: a
 * forbidden import two hops deep compiles into the same binary as a direct one.
 * This walks the graph instead, and the edges come from `Bun.Transpiler`:
 * `scanImports` lists every specifier the transpiled module still imports
 * (static, `export … from`, side-effect, literal `import()` / `require()`), so a
 * type-only import is not an edge and everything else is, and `transformSync`
 * yields the module's code without comments for a literal scan. Dead-code
 * elimination is off, so a literal behind `false ? … : …` or an env-gated
 * branch is scanned like any other — the compiled binary carries whatever the
 * build machine's environment selects.
 *
 * Resolution: `node:*` and `bun:*` are built-ins; every `tsconfig.json` path
 * alias pointing inside `packages/` is walked like source; bare npm specifiers
 * are externals, named but not walked. A non-literal `import(expr)` names no
 * module the walk can follow, so each one is counted and reported rather than
 * guessed at.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Loader = 'ts' | 'tsx' | 'js' | 'jsx';

const LOADER_BY_EXT: Record<string, Loader> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
};

const transpilers = new Map<Loader, InstanceType<typeof Bun.Transpiler>>();

function transpilerFor(file: string): InstanceType<typeof Bun.Transpiler> {
  const loader = LOADER_BY_EXT[path.extname(file)] ?? 'ts';
  let t = transpilers.get(loader);
  if (t === undefined) {
    t = new Bun.Transpiler({ loader, deadCodeElimination: false });
    transpilers.set(loader, t);
  }
  return t;
}

const isJsonModule = (file: string): boolean => path.extname(file) === '.json';

/** What the transpiler reports for one module. */
export interface RuntimeEdges {
  /** Every specifier the transpiled module imports, in source order. */
  specifiers: string[];
  /** `import(expr)` / `require(expr)` call sites whose specifier is not a literal. */
  unknowableDynamic: number;
}

const DYNAMIC_IMPORT_CALL = /\bimport\s*\(/g;
const REQUIRE_CALL = /(?<![.\w$])require\s*\(/g;

/** Edges of one module: type-only imports are absent, every other import is present. */
export function runtimeEdges(source: string, file = 'module.ts'): RuntimeEdges {
  if (isJsonModule(file)) return { specifiers: [], unknowableDynamic: 0 };
  const transpiler = transpilerFor(file);
  const entries = transpiler.scanImports(source);
  const code = transpiler.transformSync(source);
  const literalDynamic = entries.filter((e) => e.kind === 'dynamic-import' || e.kind === 'require-call').length;
  const callSites = (code.match(DYNAMIC_IMPORT_CALL)?.length ?? 0) + (code.match(REQUIRE_CALL)?.length ?? 0);
  return { specifiers: entries.map((entry) => entry.path), unknowableDynamic: Math.max(0, callSites - literalDynamic) };
}

/** The module's code with comments removed by the transpiler; JSON is read raw. */
export function codeOf(source: string, file = 'module.ts'): string {
  return isJsonModule(file) ? source : transpilerFor(file).transformSync(source);
}

interface AliasTable {
  /** `@scope/*` → absolute dir (the `*` part is appended). */
  prefixes: Record<string, string>;
  /** `@scope/name` → absolute file, for the workspace packages mapped to one entry. */
  exact: Record<string, string>;
}

/** `compilerOptions.paths` from the root tsconfig; targets inside `node_modules` stay externals. */
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
  for (const candidate of [
    base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(fromFile: string, specifier: string): Resolved {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return { kind: 'builtin', specifier };
  const exact = ALIASES.exact[specifier];
  if (exact !== undefined) {
    const file = resolveFile(exact);
    if (file === null) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable alias import ${specifier}`);
    return { kind: 'module', file };
  }
  for (const [prefix, dir] of Object.entries(ALIASES.prefixes)) {
    if (!specifier.startsWith(prefix)) continue;
    const file = resolveFile(path.join(dir, specifier.slice(prefix.length)));
    if (file === null) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable alias import ${specifier}`);
    return { kind: 'module', file };
  }
  if (specifier.startsWith('.')) {
    const file = resolveFile(path.resolve(path.dirname(fromFile), specifier));
    if (file === null) throw new Error(`${path.relative(REPO_ROOT, fromFile)}: unresolvable relative import ${specifier}`);
    return { kind: 'module', file };
  }
  return { kind: 'external', specifier };
}

export interface Closure {
  /** Every module reached (repo-relative key → absolute file), including the entries. */
  modules: Map<string, string>;
  /** First-discovered importer of each module, for a path back to an entry. */
  via: Map<string, string | null>;
  /** Bare package specifiers reached, not walked → first importer. */
  externals: Map<string, string>;
  /** Modules with `import(expr)` / `require(expr)` call sites the walk cannot follow → count. */
  unknowable: Map<string, number>;
}

/** Repo-relative, forward-slashed key of a module. */
export const moduleKey = (file: string): string => path.relative(REPO_ROOT, file).split(path.sep).join('/');

/** Every `.ts`/`.tsx` file under a directory, repo-absolute. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/** Expand an entry pattern relative to a root: `a/b.ts` or `a/**` (every file under). */
export function entryFiles(root: string, patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => (
    pattern.endsWith('/**') ? filesUnder(path.join(root, pattern.slice(0, -3))) : [path.join(root, pattern)]
  ));
}

/** Walk every module reachable from these entries. */
export function closureOf(entries: readonly string[]): Closure {
  const closure: Closure = { modules: new Map(), via: new Map(), externals: new Map(), unknowable: new Map() };
  const queue: string[] = [];
  for (const entry of entries) {
    const key = moduleKey(entry);
    if (closure.modules.has(key)) continue;
    closure.modules.set(key, entry);
    closure.via.set(key, null);
    queue.push(entry);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    const edges = runtimeEdges(fs.readFileSync(file, 'utf-8'), file);
    if (edges.unknowableDynamic > 0) closure.unknowable.set(moduleKey(file), edges.unknowableDynamic);
    for (const specifier of edges.specifiers) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved.kind === 'builtin') continue;
      if (resolved.kind === 'external') {
        if (!closure.externals.has(resolved.specifier)) closure.externals.set(resolved.specifier, moduleKey(file));
        continue;
      }
      const key = moduleKey(resolved.file);
      if (closure.modules.has(key)) continue;
      closure.modules.set(key, resolved.file);
      closure.via.set(key, moduleKey(file));
      queue.push(resolved.file);
    }
  }
  return closure;
}

/** The chain from an entry down to this module, for a failure that names how it is reached. */
export function pathToEntry(closure: Closure, key: string): string[] {
  const chain = [key];
  let at: string | null | undefined = closure.via.get(key);
  while (at !== null && at !== undefined) {
    chain.push(at);
    at = closure.via.get(at);
  }
  return chain.reverse();
}
