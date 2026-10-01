/**
 * Meta gate: what 2.0 runs reaches the 1.4 tree only through edges this file names (#1170, arch §9).
 *
 * The 1.4 tree is one strongly connected component: its directories import one another in a cycle, so it can only be
 * deleted once nothing 2.0 imports into it. This walks the import closure of the 2.0 entry points, static and dynamic
 * alike (a lazily loaded chunk ships in the same binary), and stops at the 1.4 boundary. Every edge that crosses it is
 * named below with the #1170 phase that removes it. A new crossing fails by name, and so does a named edge that no
 * longer exists: the list only shrinks, and each phase deletes its own rows.
 *
 * The boundary is closed: every file under `packages/myco/src` is reached by the walk, sits inside the 1.4 tree, or is
 * named below with why nothing reaches it. Reach that is not an import is held too: a script, a Dockerfile, the
 * Makefile or a CI workflow that names a 1.4 path is named below with its phase.
 *
 * The walk is the shared one (`tests/helpers/import-closure.ts`), so the edges are the runtime's own: a type-only
 * import is no edge, and a literal `import()` is.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  cliVerbModules, closureOf, entryFiles, filesUnder, moduleKey, REPO_ROOT, withoutShebang, type Closure,
} from '../helpers/import-closure.ts';

const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
const MYCO = 'packages/myco/src/';

/** The 1.4 directories under `packages/myco/src`: everything beneath each is 1.4 code. */
const LEGACY_DIRS: readonly string[] = [
  'agent', 'backup', 'canopy', 'capture', 'cli/providers', 'config', 'context', 'daemon', 'db', 'grove', 'host',
  'intelligence', 'logs', 'notifications', 'prompts', 'providers', 'release-provenance', 'service', 'services', 'sessions',
  'spores', 'team', 'team-host', 'templates', 'test-utils', 'tools', 'vault',
];

/** The 1.4 files in directories 2.0 shares. */
const LEGACY_FILES: readonly string[] = [
  // The 1.4 verbs the CLI dispatches to.
  'cli/agent-run.ts', 'cli/agent-tasks.ts', 'cli/attach.ts', 'cli/bootstrap.ts', 'cli/config.ts', 'cli/detect-providers.ts',
  'cli/doctor.ts', 'cli/doctor-fixes.ts', 'cli/grove.ts', 'cli/host.ts', 'cli/join.ts', 'cli/logs.ts', 'cli/open.ts',
  'cli/remove.ts', 'cli/restart.ts', 'cli/restore-backup.ts', 'cli/search.ts', 'cli/service.ts', 'cli/session.ts',
  'cli/setup-digest.ts', 'cli/setup-llm.ts', 'cli/shared.ts', 'cli/stats.ts', 'cli/subsystem.ts', 'cli/update.ts',
  'cli/upgrade.ts', 'cli/verify.ts',
  // What only the 1.4 verbs and the daemon read.
  'cli/args.ts', 'cli/confirm.ts', 'cli/dashboard-url.ts',
  'constants/power-jobs.ts', 'constants/skill-candidate-status.ts', 'constants/spore-status.ts',
  'mcp/server.ts', 'mcp/http.ts', 'mcp/external-surface.ts',
  'plans/identity.ts', 'plans/list-for-mcp.ts', 'plans/save-mcp.ts',
  'search-results.ts', 'semantic-search-filters.ts',
  'skills/content.ts', 'skills/publication.ts',
  'symbionts/canopy-read-tools.ts', 'symbionts/capabilities.ts', 'symbionts/index.ts', 'symbionts/injection-support.ts',
  'symbionts/parsers/index.ts', 'symbionts/parsers/types.ts', 'symbionts/reconcile.ts',
  'ui-assets.generated.ts', 'static-assets.generated.ts',
  'upgrade/adopt.ts', 'upgrade/auto-check.ts', 'upgrade/checker.ts', 'upgrade/in-progress.ts', 'upgrade/orchestrator.ts',
  'upgrade/schema-gap.ts', 'upgrade/spawn.ts', 'upgrade/update-events.ts',
  'utils/error-message.ts', 'utils/instrumented-fetch.ts', 'utils/interpolate-args.ts', 'utils/interpolate.ts',
  'utils/is-plain-table.ts', 'utils/json-sentinel.ts', 'utils/json.ts', 'utils/mtime-cache.ts', 'utils/parse-csv-list.ts',
  'utils/parse-json-array.ts', 'utils/per-user-lock-namespace.ts', 'utils/physical-path-identity.ts', 'utils/presence.ts',
  'utils/user-lock-root.ts', 'utils/windows-native-profile.ts',
];

const isLegacy = (key: string): boolean =>
  LEGACY_DIRS.some((dir) => key.startsWith(`${MYCO}${dir}/`))
  || LEGACY_FILES.some((file) => key === `${MYCO}${file}`);

/** A 1.4 verb module the CLI dispatches to: an edge from `cli.ts` to one is the dispatch, allowed until its verb goes. */
const isLegacyVerb = (key: string): boolean => key.startsWith(`${MYCO}cli/`) && LEGACY_FILES.includes(key.slice(MYCO.length));

/**
 * The 2.0 entry points under `packages/myco/src` (`/**` = every file under), walked with every import they make, beside
 * the CLI itself and every verb module it dispatches to that is not a 1.4 verb (`cliVerbModules`).
 */
const ENTRIES: readonly string[] = [
  'cli.ts', 'entries/**', 'hooks/**', 'member/**', 'runner/**', 'server/**',
  'mcp/stdio-bridge.ts', 'mcp/deployment-upstream.ts', 'mcp/client-call.ts',
];

/**
 * Every edge from 2.0 code into the 1.4 tree, `importer -> imported` (paths under `packages/myco/src`), with the #1170
 * phase that removes it. An edge from `cli.ts` to a 1.4 verb module is the verb's dispatch and is allowed by rule.
 */
const ALLOWED_EDGES: Readonly<Record<string, string>> = {
  'cli.ts -> backup/pre-migration-checkpoint.ts': '#1170 P4: the pre-migration checkpoint leaves the 2.0 verbs',
  'cli.ts -> daemon/main.ts': '#1170 P8: the daemon verb becomes the legacy adopt guard',
  'cli.ts -> grove/paths.ts': '#1170 P4: the pre-migration checkpoint leaves the 2.0 verbs',
  'cli.ts -> upgrade/orchestrator.ts': '#1170 P6a: one myco update replaces the 1.4 orchestrator',
  'cli.ts -> vault/resolve.ts': '#1170 P3: vault/resolve moves into project-root.ts',
  'cli/cutover.ts -> grove/subsystem-claim.ts': '#1170 P8: cutover is deleted',
  'cli/cutover.ts -> service/home-daemon.ts': '#1170 P8: cutover is deleted',
  'cli/cutover.ts -> service/legacy-units.ts': '#1170 P8: cutover is deleted',
  'cli/member.ts -> cli/doctor.ts': "#1170 P4: member export's checks move into doctor-member",
  'cli/member.ts -> vault/gitignore.ts': '#1170 P5: the vault .gitignore writer is dropped',
  'cli/tool.ts -> daemon/client.ts': '#1170 P4: the daemon upstream is deleted',
  'cli/worker-service.ts -> grove/paths.ts': '#1170 P3: the 2.0 path helpers move to paths/',
  'cli/worker-service.ts -> service/spec-builder.ts': '#1170 P3: the service spec builder moves beside server/service.ts',
  'mcp/stdio-bridge.ts -> daemon/client.ts': '#1170 P4: the daemon upstream is deleted',
  'mcp/stdio-bridge.ts -> grove/request-context.ts': '#1170 P4: the daemon upstream is deleted',
  'mcp/stdio-bridge.ts -> vault/resolve.ts': '#1170 P3: vault/resolve moves into project-root.ts',
  'member/retention.ts -> capture/buffer.ts': '#1170 P3: the capture leaves move to member/',
  'member/spool.ts -> capture/buffer.ts': '#1170 P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/prompt-kind.ts': '#1170 P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/session-continuation.ts': '#1170 P3: the capture leaves move to member/',
  'member/transcript.ts -> capture/transcript-id.ts': '#1170 P3: the capture leaves move to member/',
  'symbionts/detect.ts -> grove/paths.ts': '#1170 P3: the 2.0 path helpers move to paths/',
  'symbionts/installer.ts -> config/loader.ts': "#1170 P5: the installer's project-scope writers are dropped",
  'symbionts/installer.ts -> grove/paths.ts': '#1170 P3: the 2.0 path helpers move to paths/',
  'symbionts/installer.ts -> grove/subsystem-claim.ts': '#1170 P3: subsystem-claim moves to member/',
  'symbionts/installer/project-files.ts -> config/loader.ts': "#1170 P5: the installer's project-scope writers are dropped",
  'symbionts/member-skill-links.ts -> grove/subsystem-claim.ts': '#1170 P3: subsystem-claim moves to member/',
};

/** The 2.0 files under `packages/myco/src` nothing in the walk imports, each with how it is used. */
const UNREACHED_2_0: Readonly<Record<string, string>> = {
  'runtime/bun-sqlite.d.ts': 'type declarations, which load nothing',
  'skills/contamination.ts': "read by `lint:skills` and the shipped skills' contract, never by the binary",
  'symbionts/templates/cline/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
  'symbionts/templates/opencode/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
  'symbionts/templates/pi/plugin.ts': 'a member plugin, embedded as text by `symbionts/templates.generated.ts`',
  'upgrade/apply-binary.ts': "reached only through the 1.4 upgrade verb until #1170 P6a's myco update reads it",
  'upgrade/release-assets.ts': "reached only through the 1.4 upgrade verb until #1170 P6a's myco update reads it",
  'upgrade/release-resolver.ts': "reached only through the 1.4 upgrade verb until #1170 P6a's myco update reads it",
};

/**
 * The modules in the 2.0 closure whose text holds a call the walk reads as a non-literal `import()` or `require()`, with
 * how many. Each is text another program runs, not an import of this one's.
 */
const UNFOLLOWABLE: Readonly<Record<string, number>> = {
  // The vacuum script the Compose target runs inside its container (#1170 P7 deletes it).
  'packages/myco/src/server/deployment.ts': 1,
  // The member plugins' and launchers' text, written into an agent's own configuration.
  'packages/myco/src/symbionts/templates.generated.ts': 4,
};

/**
 * Every place outside the source a 1.4 path is named, `<file> <path it names>`, with the #1170 phase that removes it:
 * the `package.json` scripts, the Dockerfiles, the Makefile and the CI workflows and actions.
 */
const ALLOWED_TEXT_REACH: Readonly<Record<string, string>> = {
  '.github/actions/ci-setup/action.yml packages/myco/ui/package-lock.json': '#1170 P2: the 1.4 dashboard goes',
  '.github/workflows/ci.yml packages/myco/src/ui-assets.generated.ts': '#1170 P2: the 1.4 dashboard bundle check goes',
  '.github/workflows/publish.yml packages/myco/ui': '#1170 P2: the 1.4 dashboard goes',
  '.github/workflows/publish.yml packages/myco/ui/package-lock.json': '#1170 P2: the 1.4 dashboard goes',
  'Makefile packages/myco/ui': '#1170 P2: the 1.4 dashboard goes',
  'Makefile packages/myco/ui/**': '#1170 P2: the 1.4 dashboard goes',
  'packages/myco-server/package.json packages/myco/src/agent/definitions': '#1170 P7: the harness image goes',
  'packages/myco-server/package.json packages/myco/src/agent/prompts': '#1170 P7: the harness image goes',
  'packages/myco-server/package.json packages/myco/src/agent/runtime/server-entry.ts': '#1170 P7: the harness image goes',
  'packages/myco-server/package.json packages/myco/src/agent/runtime/supervisor.ts': '#1170 P7: the harness image goes',
};

/** The 1.4 dashboard, beside the 1.4 source tree. */
const LEGACY_PACKAGES: readonly string[] = ['packages/myco/ui'];

const short = (key: string): string => (key.startsWith(MYCO) ? key.slice(MYCO.length) : key);

/** A per-target entry with its embedded-file imports (`with { type: 'file' }`) taken out: those embed bytes, not code. */
const withoutEmbeds = (_file: string, text: string): string =>
  text.replace(/^import\s+\w+\s+from\s+['"][^'"]+['"]\s+with\s*\{\s*type:\s*['"]file['"]\s*\};?\s*$/gm, '');

/** The whole 2.0 closure, stopped at the 1.4 boundary: the CLI and every verb it dispatches, the other entry points, and the Deployment. */
function walk(): { myco: Closure; server: Closure } {
  const entries = [
    ...entryFiles(SRC, ENTRIES),
    ...cliVerbModules(SRC, (file) => isLegacy(moduleKey(file))),
  ];
  const myco = closureOf(entries, { stopAt: isLegacy, source: (file, text) => withoutEmbeds(file, withoutShebang(file, text)) });
  const server = closureOf(entryFiles(path.join(REPO_ROOT, 'packages', 'myco-server'), ['src/**']), { stopAt: isLegacy });
  return { myco, server };
}

/** Every edge a closure crossed from code outside the 1.4 tree into it, but the CLI's dispatch to a 1.4 verb. */
function crossings(closure: Closure): string[] {
  const out: string[] = [];
  for (const [from, imported] of closure.edges) {
    if (isLegacy(from)) continue;
    for (const to of imported) {
      if (!isLegacy(to) || (from === `${MYCO}cli.ts` && isLegacyVerb(to))) continue;
      out.push(`${short(from)} -> ${short(to)}`);
    }
  }
  return out;
}

/** The files a 1.4 path may be named in, outside the source: scripts, Dockerfiles, the Makefile and CI. */
function textFiles(): string[] {
  const packages = path.join(REPO_ROOT, 'packages');
  const manifests = ['package.json', ...fs.readdirSync(packages).flatMap((dir) => [`packages/${dir}/package.json`, `packages/${dir}/ui/package.json`, `packages/${dir}/worker/package.json`])];
  const dockerfiles = fs.readdirSync(packages).flatMap((dir) => fs.existsSync(path.join(packages, dir))
    ? fs.readdirSync(path.join(packages, dir)).filter((name) => name.startsWith('Dockerfile')).map((name) => `packages/${dir}/${name}`)
    : []);
  const yaml = (dir: string): string[] => (fs.existsSync(path.join(REPO_ROOT, dir))
    ? filesIn(path.join(REPO_ROOT, dir)).filter((file) => /\.ya?ml$/.test(file)).map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    : []);
  return [...manifests, ...dockerfiles, 'Makefile', ...yaml('.github/workflows'), ...yaml('.github/actions')]
    .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)))
    // A 1.4 package's own manifest names itself; it goes with the package.
    .filter((file) => !LEGACY_PACKAGES.some((pkg) => file.startsWith(`${pkg}/`)));
}

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}

/** The text a file holds that runs: a manifest's scripts, every other file whole. */
function runnableText(file: string): string {
  const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  if (!file.endsWith('package.json')) return text;
  return Object.values((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}).join('\n');
}

/** Every 1.4 path a file names, resolved from the file's own folder and from the repository root. */
function legacyPathsIn(file: string): string[] {
  const found = new Set<string>();
  for (const [token] of runnableText(file).matchAll(/[\w.@~*/-]*(?:src\/|myco\/ui|myco-team|myco-deploy)[\w.@*/-]*/g)) {
    for (const base of [path.dirname(file), '.']) {
      const resolved = path.posix.normalize(path.posix.join(base, token)).replace(/\/+$/, '');
      const legacy = LEGACY_PACKAGES.some((pkg) => resolved === pkg || resolved.startsWith(`${pkg}/`))
        || (resolved.startsWith(MYCO) && (isLegacy(resolved) || LEGACY_DIRS.some((dir) => resolved === `${MYCO}${dir}`)));
      if (legacy) found.add(resolved);
    }
  }
  return [...found];
}

describe('the 2.0 code', () => {
  it('reaches the 1.4 tree through the named edges alone, and every named edge still exists', () => {
    const { myco, server } = walk();
    // An `import(expr)` names no module the walk can follow, so each one in the 2.0 closure is named here: none of them is code.
    expect(Object.fromEntries([...myco.unknowable, ...server.unknowable])).toEqual(UNFOLLOWABLE);
    const found = [...new Set([...crossings(myco), ...crossings(server)])].sort();
    const named = Object.keys(ALLOWED_EDGES).sort();
    expect(found.filter((edge) => !named.includes(edge)), 'a new edge from 2.0 code into the 1.4 tree').toEqual([]);
    expect(named.filter((edge) => !found.includes(edge)), 'a named edge that no longer exists: delete its row').toEqual([]);
  }, 120_000);

  it('leaves no file under packages/myco/src unaccounted for: each is reached, inside the 1.4 tree, or named', () => {
    const { myco } = walk();
    const loose = filesUnder(SRC).map(moduleKey).filter((key) => !myco.modules.has(key) && !isLegacy(key)).map(short).sort();
    expect(loose.filter((file) => !(file in UNREACHED_2_0)), 'a file nothing 2.0 reaches and the 1.4 tree does not hold: name it, or mark it 1.4').toEqual([]);
    expect(Object.keys(UNREACHED_2_0).filter((file) => !loose.includes(file)), 'a named file the walk now reaches or the 1.4 tree holds: delete its row').toEqual([]);
    // A 1.4 entry names a file or directory that is there: a boundary that names nothing closes nothing.
    const gone = [...LEGACY_FILES.filter((file) => !fs.existsSync(path.join(SRC, file))), ...LEGACY_DIRS.filter((dir) => !fs.existsSync(path.join(SRC, dir)))];
    expect(gone, 'a 1.4 entry whose file is gone: delete it').toEqual([]);
  }, 120_000);

  it('names no 1.4 path in a script, a Dockerfile, the Makefile or CI but the ones listed', () => {
    const found = textFiles().flatMap((file) => legacyPathsIn(file).map((named) => `${file} ${named}`)).sort();
    const listed = Object.keys(ALLOWED_TEXT_REACH).sort();
    expect(found.filter((entry) => !listed.includes(entry)), 'a new 1.4 path named outside the source').toEqual([]);
    expect(listed.filter((entry) => !found.includes(entry)), 'a listed 1.4 path no longer named: delete its row').toEqual([]);
  });

  it('names, for every edge and every path it allows, the #1170 phase that removes it', () => {
    for (const [entry, phase] of Object.entries({ ...ALLOWED_EDGES, ...ALLOWED_TEXT_REACH })) {
      expect({ entry, phase }).toEqual({ entry, phase: expect.stringMatching(/^#1170 P(?:[1-9]|1[0-2])[ab]?: \S/) });
    }
  });
});
