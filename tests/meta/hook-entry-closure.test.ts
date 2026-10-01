/**
 * Gate G3 (#1561): a hook loads its own chunk and nothing else.
 *
 * A compiled binary sends `myco hook` to `hooks/entry.ts` before it loads the CLI (`entries/dispatch.ts`), and is
 * built with `--splitting`, so a hook parses only what that entry reaches. Startup is what a hook costs before it does
 * any work: the whole CLI took 175 ms to start on every hook, and the hook's own chunk takes about 25 ms. These checks
 * fail the moment an import drags the CLI, the daemon or the server back onto the hook's path.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { closureOf, pathToEntry, REPO_ROOT, runtimeEdges } from '../helpers/import-closure.ts';

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

/** The most the hook's chunk may weigh, minified. */
const HOOK_CHUNK_MAX_BYTES = 400_000;

describe('the hook entry', () => {
  it('is reached from the dispatcher before anything else loads, and the dispatcher loads nothing heavier first', () => {
    const edges = runtimeEdges(fs.readFileSync(at('entries/dispatch.ts'), 'utf-8'), at('entries/dispatch.ts'));
    expect([...edges.specifiers].sort()).toEqual([...DISPATCH_STATIC, ...DISPATCH_DYNAMIC].sort());
    for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']) {
      const entry = fs.readFileSync(at(`entries/cli.${target}.ts`), 'utf-8');
      expect({ target, dispatches: /await dispatch\(\(\) => registerEmbeddedNativeDeps\(/.test(entry) }).toEqual({ target, dispatches: true });
      expect({ target, importsCli: /import\(['"]\.\/cli\.js['"]\)/.test(entry) }).toEqual({ target, importsCli: false });
    }
  });

  it('reaches none of the CLI, the daemon, the vault, the worker or the Deployment', () => {
    const closure = closureOf([at('hooks/entry.ts'), ...DISPATCH_STATIC.map((s) => path.join(SRC, 'entries', s.replace(/\.js$/, '.ts')))]);
    const reached = [...closure.modules.keys()].flatMap((key) => {
      const hit = FORBIDDEN.find(([prefix]) => key === prefix || key.startsWith(prefix));
      return hit ? [`${hit[1]}: ${pathToEntry(closure, key).join(' -> ')}`] : [];
    });
    expect(reached).toEqual([]);
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
