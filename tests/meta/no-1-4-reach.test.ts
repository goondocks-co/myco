/**
 * Meta gate: what 2.0 runs reaches the 1.4 tree only through edges this file names (#1170, retire-1.4 P0).
 *
 * The 1.4 tree is one strongly connected component: its directories import one another in a cycle, so it can only be
 * deleted once nothing 2.0 imports into it. This walks the import closure of the 2.0 entry points, static and dynamic
 * alike (a lazily loaded chunk ships in the same binary), and stops at the 1.4 boundary. Every edge that crosses it is
 * named below with the phase of the retirement plan that removes it. A new crossing fails by name, and so does a named
 * edge that no longer exists: the list only shrinks, and each phase deletes its own rows.
 *
 * The walk is the shared one (`tests/helpers/import-closure.ts`), so the edges are the runtime's own: a type-only
 * import is no edge, and a literal `import()` is.
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { closureOf, entryFiles, REPO_ROOT, type Closure } from '../helpers/import-closure.ts';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const MYCO = 'packages/myco/src/';

/** The 1.4 directories under `packages/myco/src`: everything beneath each is 1.4 code. */
const LEGACY_DIRS: readonly string[] = [
  'agent', 'backup', 'canopy', 'capture', 'config', 'context', 'daemon', 'db', 'grove', 'host', 'intelligence',
  'notifications', 'prompts', 'providers', 'release-provenance', 'service', 'services', 'sessions', 'spores', 'team',
  'team-host', 'templates', 'tools', 'vault', 'worker',
];

/** The 1.4 files in directories 2.0 shares: the 1.4 daemon's MCP, the 1.4 dashboard's bundle, auto-adopt and the 1.4 verbs. */
const LEGACY_FILES: readonly string[] = [
  'mcp/server.ts', 'mcp/http.ts', 'mcp/external-surface.ts',
  'ui-assets.generated.ts', 'static-assets.generated.ts',
  'upgrade/adopt.ts', 'upgrade/auto-check.ts', 'upgrade/checker.ts', 'upgrade/in-progress.ts', 'upgrade/orchestrator.ts',
  'upgrade/schema-gap.ts', 'upgrade/spawn.ts', 'upgrade/update-events.ts',
  'cli/agent-run.ts', 'cli/agent-tasks.ts', 'cli/attach.ts', 'cli/bootstrap.ts', 'cli/config.ts', 'cli/detect-providers.ts',
  'cli/doctor.ts', 'cli/doctor-fixes.ts', 'cli/grove.ts', 'cli/host.ts', 'cli/join.ts', 'cli/logs.ts', 'cli/open.ts',
  'cli/remove.ts', 'cli/restart.ts', 'cli/restore-backup.ts', 'cli/search.ts', 'cli/service.ts', 'cli/session.ts',
  'cli/setup-digest.ts', 'cli/setup-llm.ts', 'cli/shared.ts', 'cli/stats.ts', 'cli/subsystem.ts', 'cli/update.ts',
  'cli/upgrade.ts', 'cli/verify.ts',
];

const isLegacy = (key: string): boolean =>
  key.startsWith('packages/myco-team/')
  || LEGACY_DIRS.some((dir) => key.startsWith(`${MYCO}${dir}/`))
  || LEGACY_FILES.some((file) => key === `${MYCO}${file}`);

/** The 2.0 entry points under `packages/myco/src` (`/**` = every file under), walked with every import they make. */
const ENTRIES: readonly string[] = [
  'entries/**', 'hooks/**', 'member/**', 'runner/**', 'server/**',
  'mcp/stdio-bridge.ts', 'mcp/deployment-upstream.ts', 'mcp/client-call.ts',
  'cli/cutover.ts', 'cli/import.ts', 'cli/login.ts', 'cli/member.ts', 'cli/member-dispatch.ts', 'cli/server.ts',
  'cli/settings.ts', 'cli/tool.ts', 'cli/worker.ts',
];

/**
 * Every edge from 2.0 code into the 1.4 tree, `importer -> imported` (paths under `packages/myco/src`), with the phase
 * of the retirement plan (`docs/superpowers/plans/2026-09-30-retire-1-4/plan.md` §3) that removes it.
 */
const ALLOWED_EDGES: Readonly<Record<string, string>> = {
  'cli.ts -> vault/resolve.ts': 'P3: vault/resolve moves into project-root.ts',
  'cli/cutover.ts -> grove/subsystem-claim.ts': 'P8: cutover is deleted',
  'cli/cutover.ts -> service/home-daemon.ts': 'P8: cutover is deleted',
  'cli/cutover.ts -> service/legacy-units.ts': 'P8: cutover is deleted',
  'cli/member.ts -> cli/doctor.ts': "P4: member export's checks move into doctor-member",
  'cli/member.ts -> vault/gitignore.ts': 'P5: the vault .gitignore writer is dropped',
  'cli/tool.ts -> daemon/client.ts': 'P4: the daemon upstream is deleted',
  'cli/worker-service.ts -> grove/paths.ts': 'P3: the 2.0 path helpers move to paths/',
  'cli/worker-service.ts -> service/spec-builder.ts': 'P3: the service spec builder moves beside server/service.ts',
  'mcp/stdio-bridge.ts -> daemon/client.ts': 'P4: the daemon upstream is deleted',
  'mcp/stdio-bridge.ts -> grove/request-context.ts': 'P4: the daemon upstream is deleted',
  'mcp/stdio-bridge.ts -> vault/resolve.ts': 'P3: vault/resolve moves into project-root.ts',
  'member/retention.ts -> capture/buffer.ts': 'P3: the capture leaves move to member/',
  'member/spool.ts -> capture/buffer.ts': 'P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/prompt-kind.ts': 'P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/session-continuation.ts': 'P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/transcript-id.ts': 'P3: the capture leaves move to member/',
  'symbionts/detect.ts -> grove/paths.ts': 'P3: the 2.0 path helpers move to paths/',
  'symbionts/installer.ts -> config/loader.ts': "P5: the installer's project-scope writers are dropped",
  'symbionts/installer.ts -> grove/paths.ts': 'P3: the 2.0 path helpers move to paths/',
  'symbionts/installer.ts -> grove/subsystem-claim.ts': 'P3: subsystem-claim moves to member/',
  'symbionts/installer/project-files.ts -> config/loader.ts': "P5: the installer's project-scope writers are dropped",
  'symbionts/member-skill-links.ts -> grove/subsystem-claim.ts': 'P3: subsystem-claim moves to member/',
};

/**
 * The modules in the 2.0 closure whose text holds a call the walk reads as a non-literal `import()` or `require()`, with
 * how many. Each is text another program runs, not an import of this one's.
 */
const UNFOLLOWABLE: Readonly<Record<string, number>> = {
  // The vacuum script the Compose target runs inside its container (P7 deletes it).
  'packages/myco/src/server/deployment.ts': 1,
  // The member plugins' and launchers' text, written into an agent's own configuration.
  'packages/myco/src/symbionts/templates.generated.ts': 4,
};

const short = (key: string): string => (key.startsWith(MYCO) ? key.slice(MYCO.length) : key);

/** Every edge a closure crossed from code outside the 1.4 tree into it. */
function crossings(closure: Closure): string[] {
  const out: string[] = [];
  for (const [from, imported] of closure.edges) {
    if (isLegacy(from)) continue;
    for (const to of imported) if (isLegacy(to)) out.push(`${short(from)} -> ${short(to)}`);
  }
  return out;
}

/** `cli.ts` with its shebang line taken out, which the closure's parser reads as source. */
const withoutShebang = (_file: string, text: string): string => text.replace(/^#!.*\n/, '');

/** A per-target entry with its embedded-file imports (`with { type: 'file' }`) taken out: those embed bytes, not code. */
const withoutEmbeds = (_file: string, text: string): string =>
  text.replace(/^import\s+\w+\s+from\s+['"][^'"]+['"]\s+with\s*\{\s*type:\s*['"]file['"]\s*\};?\s*$/gm, '');

describe('the 2.0 code', () => {
  it('reaches the 1.4 tree through the named edges alone, and every named edge still exists', () => {
    // The CLI's own module loads every verb lazily, 1.4 verbs among them: only what it loads before it knows the verb counts here.
    const cli = closureOf([path.join(SRC, 'cli.ts')], { staticOnly: true, source: withoutShebang, stopAt: isLegacy });
    // The dispatcher loads the CLI for every verb but a hook; the CLI is held to its static imports above, not walked again.
    const verbs = closureOf(entryFiles(SRC, ENTRIES), { stopAt: (key) => key === `${MYCO}cli.ts` || isLegacy(key), source: (file, text) => withoutEmbeds(file, withoutShebang(file, text)) });
    const server = closureOf(entryFiles(path.join(REPO_ROOT, 'packages', 'myco-server'), ['src/**']), { stopAt: isLegacy });
    // An `import(expr)` names no module the walk can follow, so each one in the 2.0 closure is named here: none of them is code.
    expect(Object.fromEntries([...verbs.unknowable, ...server.unknowable])).toEqual(UNFOLLOWABLE);
    const found = [...new Set([...crossings(cli), ...crossings(verbs), ...crossings(server)])].sort();
    const named = Object.keys(ALLOWED_EDGES).sort();
    expect(found.filter((edge) => !named.includes(edge)), 'a new edge from 2.0 code into the 1.4 tree').toEqual([]);
    expect(named.filter((edge) => !found.includes(edge)), 'a named edge that no longer exists: delete its row').toEqual([]);
  }, 120_000);

  it('names, for every edge it allows, the phase that removes it', () => {
    for (const [edge, phase] of Object.entries(ALLOWED_EDGES)) expect({ edge, phase }).toEqual({ edge, phase: expect.stringMatching(/^P(?:[1-9]|1[0-2])[ab]?: \S/) });
  });
});
