/**
 * Gate G3 (#1561): a hook loads its own chunk and nothing else.
 *
 * A compiled binary sends `myco hook` to `hooks/entry.ts` before it loads the CLI (`entries/dispatch.ts`), and is
 * built with `--splitting`, so a hook parses only what that entry reaches. Startup is what a hook costs before it does
 * any work: the whole CLI took 175 ms to start on every hook, and the hook's own chunk takes about 25 ms. These checks
 * fail the moment an import drags the CLI, the daemon or the server back onto the hook's path.
 *
 * Every other verb starts in the CLI (`cli.ts`), which loads a verb's module only once it knows the verb. The CLI's
 * own static imports reach none of the 1.4 daemon, its service manager, the vault or the Deployment; a 2.0 verb's
 * module reaches no 1.4 daemon module; and no verb's module but the daemon's own reaches the 1.4 daemon's server.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { cliVerbModules, closureOf, pathToEntry, REPO_ROOT, runtimeEdges, withoutShebang } from '../helpers/import-closure.ts';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const at = (rel: string): string => path.join(SRC, rel);

/** What runs before the hook's own chunk: the dispatcher's static imports. */
const DISPATCH_STATIC = ['../cli/env-file.js', '../cli/loopback-proxy.js'];
/** The only dynamic imports the dispatcher makes: the hook's chunk, and the CLI for every other verb. */
const DISPATCH_DYNAMIC = ['../hooks/entry.js', '../cli.js'];

/** Module prefixes a hook never loads, each naming what it would cost. */
const FORBIDDEN: ReadonlyArray<[string, string]> = [
  ['packages/myco/src/cli.ts', 'the CLI'],
  ['packages/myco/src/cli/shared.ts', 'the CLI helpers, which reach the 1.4 daemon client'],
  ['packages/myco/src/daemon/', 'the 1.4 daemon'],
  ['packages/myco/src/db/', 'the 1.4 vault'],
  ['packages/myco/src/agent/', 'the 1.4 agent'],
  ['packages/myco/src/config/', 'the 1.4 configuration loader'],
  ['packages/myco/src/mcp/', 'the MCP server'],
  ['packages/myco/src/ui/', 'the dashboard'],
  ['packages/myco/src/runner/', 'the worker'],
  ['packages/myco-server/', 'the Deployment'],
];

/** What only the CLI may load: the native artifacts' registration opens the sqlite and ripgrep files a hook never needs. */
const HOOK_CHUNK_ONLY_FORBIDDEN: ReadonlyArray<[string, string]> = [
  ['packages/myco/src/runtime/native-deps.ts', 'the native artifacts (sqlite, ripgrep)'],
];

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];

/** A per-target entry with its embedded-file imports (`with { type: 'file' }`) taken out: those embed bytes, not code. */
const withoutEmbeds = (_file: string, text: string): string =>
  text.replace(/^import\s+\w+\s+from\s+['"][^'"]+['"]\s+with\s*\{\s*type:\s*['"]file['"]\s*\};?\s*$/gm, '');

/** Every forbidden module a closure reaches, with the chain that reaches it. */
function forbiddenIn(closure: ReturnType<typeof closureOf>, forbidden: ReadonlyArray<[string, string]>): string[] {
  return [...closure.modules.keys()].flatMap((key) => {
    const hit = forbidden.find(([prefix]) => key === prefix || key.startsWith(prefix));
    return hit ? [`${hit[1]}: ${pathToEntry(closure, key).join(' -> ')}`] : [];
  });
}

/** The most the hook's chunk may weigh, minified. */
const HOOK_CHUNK_MAX_BYTES = 400_000;

describe('the hook entry', () => {
  it('is reached from the dispatcher before anything else loads, and the dispatcher loads nothing heavier first', () => {
    const edges = runtimeEdges(fs.readFileSync(at('entries/dispatch.ts'), 'utf-8'), at('entries/dispatch.ts'));
    expect([...edges.specifiers].sort()).toEqual([...DISPATCH_STATIC, ...DISPATCH_DYNAMIC].sort());
    for (const target of TARGETS) {
      const entry = fs.readFileSync(at(`entries/cli.${target}.ts`), 'utf-8');
      expect({ target, dispatches: /await dispatch\(\(\) => registerEmbeddedNativeDeps\(/.test(entry) }).toEqual({ target, dispatches: true });
      expect({ target, importsCli: /import\(['"]\.\/cli\.js['"]\)/.test(entry) }).toEqual({ target, importsCli: false });
    }
  });

  it('loads, before it dispatches, only what every verb needs: each target entry\'s static closure reaches none of the CLI, the daemon or the Deployment', () => {
    for (const target of TARGETS) {
      const closure = closureOf([at(`entries/cli.${target}.ts`)], { staticOnly: true, source: withoutEmbeds });
      expect({ target, reached: forbiddenIn(closure, FORBIDDEN) }).toEqual({ target, reached: [] });
      // No npm package loads before the dispatch: a package on this path is parsed by every hook.
      expect({ target, externals: [...closure.externals.keys()] }).toEqual({ target, externals: [] });
      expect({ target, dispatcher: closure.modules.has('packages/myco/src/entries/dispatch.ts') }).toEqual({ target, dispatcher: true });
    }
  });

  it('reaches, in its own chunk, none of the CLI, the daemon, the vault, the worker, the Deployment, an npm package or the native artifacts', () => {
    const closure = closureOf([at('hooks/entry.ts'), ...DISPATCH_STATIC.map((s) => path.join(SRC, 'entries', s.replace(/\.js$/, '.ts')))]);
    expect(forbiddenIn(closure, [...FORBIDDEN, ...HOOK_CHUNK_ONLY_FORBIDDEN])).toEqual([]);
    expect([...closure.externals.keys()]).toEqual([]);
    expect([...closure.unknowable.keys()]).toEqual([]);
  });

  it('weighs no more than its ceiling once bundled', () => {
    // Bundled by the same `bun build` the binary is compiled with, in a process of its own.
    const built = Bun.spawnSync([process.execPath, 'build', '--minify', '--target=bun', at('hooks/entry.ts')], { cwd: path.join(REPO_ROOT, 'packages', 'myco'), stdout: 'pipe', stderr: 'pipe' });
    expect({ exitCode: built.exitCode, stderr: built.stderr.toString().slice(0, 500) }).toEqual({ exitCode: 0, stderr: '' });
    expect(built.stdout.byteLength).toBeLessThan(HOOK_CHUNK_MAX_BYTES);
    expect(built.stdout.byteLength).toBeGreaterThan(10_000);
  }, 60_000);
});


/** What the CLI loads before it knows the verb never reaches, each naming what it would cost. */
const CLI_STARTUP_FORBIDDEN: ReadonlyArray<[string, string]> = [
  ['packages/myco/src/cli/shared.ts', 'the 1.4 CLI helpers'],
  ['packages/myco/src/daemon/', 'the 1.4 daemon'],
  ['packages/myco/src/service/', 'the 1.4 daemon\'s service manager'],
  ['packages/myco/src/db/', 'the 1.4 vault'],
  ['packages/myco/src/agent/', 'the 1.4 agent'],
  ['packages/myco/src/config/', 'the 1.4 configuration loader'],
  ['packages/myco/src/mcp/', 'the MCP server'],
  ['packages/myco/src/ui/', 'the dashboard'],
  ['packages/myco/src/runner/', 'the worker'],
  ['packages/myco-server/', 'the Deployment'],
];

/** The modules of the 2.0 verbs and what they load: membership, sign-in, import, settings, the worker, a credential's tool and MCP bridge, and the checks `member export` reads from `doctor`. */
const VERBS_2_0 = [
  'cli/member.ts', 'cli/member-dispatch.ts', 'cli/login.ts', 'cli/import.ts', 'cli/settings.ts', 'cli/worker.ts',
  'cli/join.ts', 'cli/tool.ts', 'mcp/stdio-bridge.ts', 'cli/doctor.ts',
];

/** The one verb module that is the 1.4 daemon. */
const THE_DAEMON = 'daemon/main.ts';
const DAEMON_SERVER = 'packages/myco/src/daemon/server.ts';

describe('a verb other than a hook', () => {
  it('starts in a CLI whose own imports reach none of the 1.4 daemon, the vault, the Deployment or an npm package', () => {
    const closure = closureOf([at('cli.ts')], { staticOnly: true, source: withoutShebang });
    expect(forbiddenIn(closure, CLI_STARTUP_FORBIDDEN)).toEqual([]);
    expect([...closure.externals.keys()]).toEqual([]);
  });

  it('loads, for a 2.0 verb, a module that reaches no 1.4 daemon module', () => {
    for (const verb of VERBS_2_0) {
      const closure = closureOf([at(verb)], { staticOnly: true });
      expect({ verb, reached: forbiddenIn(closure, [['packages/myco/src/daemon/', 'the 1.4 daemon']]) }).toEqual({ verb, reached: [] });
    }
  });

  it('loads, for every verb but the daemon itself, a module that never reaches the 1.4 daemon\'s server', () => {
    // The verb modules are read off the CLI's own imports, then off the lazy imports of each module found, so a verb
    // that a dispatcher (`cli/member-dispatch.ts`) loads with `import('./…')` is held here without being listed.
    const modules = cliVerbModules(SRC, (file) => path.relative(SRC, file) === THE_DAEMON);
    expect(modules.size).toBeGreaterThan(20);
    // The member verbs `cli/member-dispatch.ts` loads lazily are among the modules held.
    for (const verb of ['cli/member-reads.ts', 'cli/member-doctor.ts', 'cli/member-logs.ts', 'cli/member-config.ts']) {
      expect({ verb, held: modules.has(at(verb)) }).toEqual({ verb, held: true });
    }
    for (const file of modules) {
      const closure = closureOf([file], { staticOnly: true });
      const reached = closure.modules.has(DAEMON_SERVER) ? pathToEntry(closure, DAEMON_SERVER).join(' -> ') : null;
      expect({ verb: path.relative(SRC, file), reached }).toEqual({ verb: path.relative(SRC, file), reached: null });
    }
    // The daemon's own module is the exception because it is the server, and it still is.
    expect(closureOf([at(THE_DAEMON)], { staticOnly: true }).modules.has(DAEMON_SERVER)).toBe(true);
  }, 120_000);
});
