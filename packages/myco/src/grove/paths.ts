import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MACHINE_RUNTIME_COMMAND_FILENAME } from '../constants/update.js';
import { assertGroveEraId, isGroveEraId } from './ids.js';

/**
 * True when two filesystem paths point at the same file or directory —
 * across symlink chains AND across case-insensitive filesystems
 * (macOS APFS, Windows NTFS) where `path.resolve` alone returns
 * different strings for the same on-disk file.
 *
 * Compares inode + device after `path.resolve`. Returns false when
 * either path doesn't exist (treat-as-different is what every caller
 * wants — a registered root that no longer exists is effectively a
 * different path).
 *
 * Use this anywhere two filesystem paths are compared for identity:
 * registry-root vs daemon-resolved-root, marker.project_root vs
 * expected.projectRoot, etc. Bare `path.resolve(a) === path.resolve(b)`
 * is a foot-gun on macOS.
 */
export function pathsEquivalent(a: string, b: string): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (resolvedA === resolvedB) return true;
  try {
    const statA = fs.statSync(resolvedA);
    const statB = fs.statSync(resolvedB);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

export const MYCO_HOME_ENV = 'MYCO_HOME';
export const GROVES_DIRNAME = 'groves';
export const SERVICE_DIRNAME = 'service';
export const GROVE_METADATA_FILENAME = 'grove.toml';
export const GROVE_CONFIG_FILENAME = 'grove.yaml';
export const GROVE_DB_FILENAME = 'myco.db';
export const GROVE_VECTORS_FILENAME = 'vectors.db';
export const GROVE_REGISTRY_DIRNAME = 'registry';
export const GROVE_PROJECTS_FILENAME = 'projects.toml';
export const GROVE_ROOTS_FILENAME = 'roots.toml';
export const GLOBAL_CONFIG_FILENAME = 'config.yaml';
export const GROVE_REGISTRY_FILENAME = 'registry.yaml';
export const PROJECT_MANIFEST_FILENAME = 'project.toml';
export const PROJECT_LOCAL_MANIFEST_FILENAME = 'project.local.toml';
export const DAEMON_STATE_FILENAME = 'daemon.json';

export interface MycoHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export function resolveMycoHome(options: MycoHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[MYCO_HOME_ENV]?.trim();
  if (configured) return path.resolve(expandHome(configured, options.homeDir));
  return path.join(options.homeDir ?? os.homedir(), '.myco');
}

/**
 * True when `mycoHome` resolves to the canonical default home (`~/.myco`),
 * ignoring any `MYCO_HOME` override. This home is the production install every
 * released user shares; a non-default home (e.g. `~/.myco-dev`) is the dogfood
 * path. Used to key the default-home service label and the dev-build guard.
 */
export function isDefaultMycoHome(mycoHome: string): boolean {
  return path.resolve(mycoHome) === resolveMycoHome({ env: {} });
}

/**
 * The daemon's identity token — its resolved home path. An opaque,
 * equality-compared owner used for subsystem claims: two independent installs
 * in two homes own subsystems distinctly. Two daemons sharing one home are the
 * same identity (only one should run per home).
 */
export function daemonIdentity(mycoHome: string = resolveMycoHome()): string {
  return path.resolve(mycoHome);
}

/**
 * Resolve the root directory for project-scoped backups. Precedence:
 *   1. Explicit `override` argument.
 *   2. `MYCO_BACKUPS_DIR` environment variable.
 *   3. `~/myco_backups`.
 */
export function resolveBackupsRoot(override?: string): string {
  if (override && override.trim().length > 0) return path.resolve(override);
  const env = process.env.MYCO_BACKUPS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), 'myco_backups');
}

export function resolveGlobalConfigPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, GLOBAL_CONFIG_FILENAME);
}

/**
 * Resolve the canonical path for the cached machine identity. One file
 * per machine, shared across every Grove and every project — the value
 * was previously cached per-project at `<projectVaultDir>/machine_id`,
 * which produced one identity per vault and forced every team-sync /
 * backup-dedup consumer to re-resolve when crossing projects.
 *
 * Post-global-install: `~/.myco/machine_id` is the single source. The
 * value moves on first read after the global-install migration runs
 * (the migration step propagates an existing project-vault value when
 * the global file is absent — see plan §5).
 */
export function resolveMachineIdPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, 'machine_id');
}

/**
 * Resolve the canonical path for the last-update version stamp.
 * Written by `myco update` after each successful pass — informational
 * marker only, not a migration gate. Per-machine bookkeeping; lives
 * alongside the launchers it tracks rather than in any single project.
 */
export function resolveLastUpdateVersionPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, 'last-update-version');
}

export function resolveServiceDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, SERVICE_DIRNAME);
}

export function resolveServiceDaemonStatePath(mycoHome = resolveMycoHome()): string {
  return path.join(resolveServiceDir(mycoHome), DAEMON_STATE_FILENAME);
}

export function resolveGrovesDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, GROVES_DIRNAME);
}

/**
 * `~/.myco/groves/registry.yaml` — owns the cross-Grove pointer
 * (`default_grove_id`). Lives next to `groves/<id>/` so the registry
 * stays close to its data; the machine-tier `config.yaml` no longer
 * carries a `grove:` block.
 */
export function resolveGroveRegistryPath(mycoHome = resolveMycoHome()): string {
  return path.join(resolveGrovesDir(mycoHome), GROVE_REGISTRY_FILENAME);
}

/**
 * Structural Grove-id gate. Every path resolver below funnels through
 * this helper before joining `groveId` onto a `~/.myco/groves/...` path,
 * so a hostile (or buggy) caller cannot escape the Grove namespace via
 * `..` segments, absolute paths, or any value that fails the
 * `grove_<32 hex chars>` shape.
 *
 * The brand is enforced structurally (defense in depth): even if an
 * upstream caller drops its own validation, the resolver still refuses
 * malformed ids. Throws via `assertGroveEraId` on bad input.
 */
function assertGroveIdSafe(groveId: string): string {
  return assertGroveEraId(groveId, 'grove');
}

export function resolveGroveDir(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGrovesDir(mycoHome), assertGroveIdSafe(groveId));
}

export const TEAM_HOME_DIRNAME = '.myco-team';
export const MYCO_TEAM_HOME_ENV = 'MYCO_TEAM_HOME';

/**
 * Machine-scoped home for the team registry. Independent of MYCO_HOME so a
 * machine running more than one daemon home (~/.myco + ~/.myco-dev) shares one
 * team registry — mirrors the Collective home (~/.myco-collective). Override
 * via MYCO_TEAM_HOME for hermetic tests. Default: ~/.myco-team.
 */
export function resolveTeamsHome(options: MycoHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env[MYCO_TEAM_HOME_ENV]?.trim();
  if (override) return path.resolve(expandHome(override, options.homeDir));
  return path.join(options.homeDir ?? os.homedir(), TEAM_HOME_DIRNAME);
}

export const TEAMS_DIRNAME = 'teams';

export function resolveTeamsDir(): string {
  return path.join(resolveTeamsHome(), TEAMS_DIRNAME);
}

export function resolveTeamDir(teamId: string): string {
  assertGroveEraId(teamId, 'team');
  return path.join(resolveTeamsDir(), teamId);
}

export function resolveTeamConfigPath(teamId: string): string {
  return path.join(resolveTeamDir(teamId), 'team.json');
}

export function resolveTeamSecretsPath(teamId: string): string {
  return path.join(resolveTeamDir(teamId), 'secrets.env');
}

export const HOSTS_DIRNAME = 'hosts';

/**
 * Sibling of `resolveTeamsDir` under the same machine-global team home
 * (`~/.myco-team`) — Team Host reuses that home rather than minting a new
 * one, since both are machine-global "who is this machine connected to"
 * registries.
 */
export function resolveHostsDir(): string {
  return path.join(resolveTeamsHome(), HOSTS_DIRNAME);
}

export function resolveHostDir(hostId: string): string {
  assertGroveEraId(hostId, 'host');
  return path.join(resolveHostsDir(), hostId);
}

export function resolveHostConfigPath(hostId: string): string {
  return path.join(resolveHostDir(hostId), 'host.json');
}

export const HOST_CONTROL_DIRNAME = 'host';

/**
 * HOST-side control-plane home — this machine acting AS a Team Host. Holds the
 * provisioned overlay binaries (`bin/`), the generated Headscale config + sqlite
 * state (`headscale/`), and the host state record (`state.json`). Under the same
 * machine-global team home (`~/.myco-team`) as `teams/` and `hosts/`.
 *
 * Deliberately SINGULAR (`host`) to distinguish it from {@link resolveHostsDir}
 * (`hosts/`, plural): `host/` is "this machine serving a Grove to others";
 * `hosts/` is "the hosts this machine has joined as a member". Managed by
 * `myco-team host enable/disable` (Task 2.1).
 */
export function resolveHostControlDir(): string {
  return path.join(resolveTeamsHome(), HOST_CONTROL_DIRNAME);
}

export function resolveHostSecretsPath(hostId: string): string {
  return path.join(resolveHostDir(hostId), 'secrets.env');
}

export const ROUTED_TRANSCRIPTS_DIRNAME = 'routed-transcripts';

/**
 * A filesystem-safe capture path segment: non-empty, no separators, no `.`/`..`,
 * charset `[A-Za-z0-9._-]`. Unlike the Grove/host/project ids, `machine_id` and
 * `session_id` are NOT brand-shaped era ids (machine_id is `{user}_{hash}`,
 * session_id is an agent-supplied uuid), so they get this structural guard rather
 * than {@link assertGroveEraId}. Throws on any value that could escape its
 * intended directory — the traversal defense for wire-supplied path components.
 */
export function assertSafeCaptureSegment(value: string, kind: string): string {
  if (!value || value === '.' || value === '..' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Unsafe ${kind} path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * HOST-side materialized-transcript cache root — `~/.myco-team/host/routed-transcripts/`.
 * A routed session's transcript bytes, pushed from the member and appended here so
 * the host miner has a local file to reconcile (capture-push §5.2). Machine-scoped
 * (under the host control home, {@link resolveHostControlDir}), NOT per-Grove: the
 * tree is keyed `<machine_id>/<session_id>/<transcript_id>.jsonl`, a mining cache
 * the Grove DB is authoritative over once mined.
 */
export function resolveRoutedTranscriptsDir(): string {
  return path.join(resolveHostControlDir(), ROUTED_TRANSCRIPTS_DIRNAME);
}

/**
 * The materialized file path for one routed transcript:
 * `<routed-transcripts>/<machine_id>/<session_id>/<transcript_id>.jsonl`. Every
 * wire-supplied segment funnels through {@link assertSafeCaptureSegment} before
 * being joined, so a hostile `machine_id`/`session_id`/`transcript_id` cannot
 * escape the cache root via `..` or separators (defense in depth alongside the
 * ingest handler's own validation).
 */
export function resolveRoutedTranscriptPath(
  machineId: string,
  sessionId: string,
  transcriptId: string,
): string {
  return path.join(
    resolveRoutedTranscriptsDir(),
    assertSafeCaptureSegment(machineId, 'machine_id'),
    assertSafeCaptureSegment(sessionId, 'session_id'),
    `${assertSafeCaptureSegment(transcriptId, 'transcript_id')}.jsonl`,
  );
}

export const MEMBER_OVERLAY_DIRNAME = 'member';

/**
 * MEMBER-side overlay home — this machine acting as a Team Host MEMBER (it has
 * joined one or more hosts via `myco join`, Task 2.2). Holds the provisioned
 * Tailscale binaries (`bin/`), shared across every joined host (the CLI + daemon
 * BINARIES are identical; only the running per-host instances differ). Under the
 * same machine-global team home (`~/.myco-team`) as `teams/`, `hosts/`, and the
 * host-side `host/`.
 *
 * MULTI-HOST: each joined host is its OWN Headscale tailnet (each independently
 * hands out `100.64.0.0/10` — two hosts can both be `100.64.0.1`), so the member
 * runs ONE userspace tailscaled PER HOST, each with its own socket + statedir +
 * outbound-proxy port. The per-host state lives under that host's registry dir
 * ({@link resolveMemberTailscaledStateDir}); only the shared binaries live here.
 */
export function resolveMemberOverlayDir(): string {
  return path.join(resolveTeamsHome(), MEMBER_OVERLAY_DIRNAME);
}

/** Where the member's Tailscale client + daemon binaries land (shared across hosts). */
export function resolveMemberBinDir(): string {
  return path.join(resolveMemberOverlayDir(), 'bin');
}

export const MEMBER_TRANSCRIPT_DRAIN_DIRNAME = 'transcript-drain';

/**
 * MEMBER-side durable work-queue home for the routed transcript-content drain
 * (capture-push §5.2, plan C1). One JSON entry per `(host_id, session_id,
 * transcript_id)` carrying the host-acked high-water offset, persisted so the
 * high-water survives daemon restart. Machine-scoped under the member overlay
 * home — NOT a Grove-DB table: an attached project has no local Grove DB (§4),
 * so this is the transcript analog of the DB-free EventBuffer (`capture/buffer.ts`).
 * Tests point `MYCO_TEAM_HOME` at a tmpdir for hermetic disk.
 */
export function resolveMemberTranscriptDrainDir(): string {
  return path.join(resolveMemberOverlayDir(), MEMBER_TRANSCRIPT_DRAIN_DIRNAME);
}

export const MEMBER_PLAN_DRAIN_DIRNAME = 'plan-drain';

/**
 * MEMBER-side durable work-queue home for the routed plan-content companion push
 * (capture-push §5.5, plan C7). One JSON entry per `(host_id, session_id,
 * plan_ref)` carrying the host-acked CONTENT HASH, so a re-push of unchanged plan
 * content is a member-side no-op and a restart resumes at the same high-water.
 * Machine-scoped under the member overlay home — NOT a Grove-DB table: an attached
 * project has no local Grove DB (§4), so this is the whole-file sibling of
 * {@link resolveMemberTranscriptDrainDir} (which streams byte-offset deltas). A
 * plan file is small and read WHOLE, so the queue keys on a content hash rather
 * than a byte offset. Tests point `MYCO_TEAM_HOME` at a tmpdir for hermetic disk.
 */
export function resolveMemberPlanDrainDir(): string {
  return path.join(resolveMemberOverlayDir(), MEMBER_PLAN_DRAIN_DIRNAME);
}

export const MEMBER_EVENT_REPLAY_DRAIN_DIRNAME = 'event-replay-drain';

/**
 * MEMBER-side durable high-water home for the attach-aware live-event replay
 * drain (capture-push §7 task 5, plan C5). One JSON entry per `(host_id,
 * session_id)` carrying the count of collect-buffer records the host has already
 * acked, so a reconnect resends only un-shipped events and a restart resumes at
 * the same high-water. Machine-scoped under the member overlay home — NOT a
 * Grove-DB table: an attached project has no local Grove DB (§4), so this is the
 * sibling of {@link resolveMemberTranscriptDrainDir} for the DB-free collector
 * buffer (`capture/buffer.ts`). Tests point `MYCO_TEAM_HOME` at a tmpdir for
 * hermetic disk.
 */
export function resolveMemberEventReplayDrainDir(): string {
  return path.join(resolveMemberOverlayDir(), MEMBER_EVENT_REPLAY_DRAIN_DIRNAME);
}

/**
 * A short, deterministic per-host tag (10 hex chars of a hash of the host_id).
 * Used to key a host's tailscaled socket + LaunchAgent label. A hash rather than
 * the raw host_id keeps the socket path well under the macOS `sun_path` limit
 * (a raw `host_<32hex>` segment plus a deep-ish home can crowd 104 bytes) and is
 * format-independent, while staying collision-free for the handful of hosts a
 * single machine realistically joins.
 */
export function memberHostTag(hostId: string): string {
  return crypto.createHash('sha256').update(hostId).digest('hex').slice(0, 10);
}

/** A host's userspace-tailscaled `--statedir` (its node identity/state). Lives
 *  under that host's registry dir so `removeHost` (leave) cleans it too. May be
 *  arbitrarily deep — only the SOCKET path is length-constrained. */
export function resolveMemberTailscaledStateDir(hostId: string): string {
  return path.join(resolveHostDir(hostId), 'tailscaled-state');
}

/**
 * A host's userspace-tailscaled `--socket` path. Deliberately HOME-anchored and
 * SHORT — NOT under the (possibly deep, overridable) `MYCO_TEAM_HOME` — because
 * macOS caps an `AF_UNIX` `sun_path` at 104 bytes and a team-home-derived path
 * silently breaks `bind()` (the scratchpad/test case, proven to overflow in the
 * live spike §0.1b). Per-host now (multi-host): the {@link memberHostTag} segment
 * distinguishes each host's socket while staying short; a pathologically long
 * home falls back to a `/tmp` path that is always short. Both the tailscaled
 * LaunchAgent and the `tailscale --socket=<…>` CLI calls resolve through here for
 * the SAME host, so they always agree.
 */
export function resolveMemberTailscaledSocketPath(hostId: string): string {
  const tag = memberHostTag(hostId);
  const preferred = path.join(resolveHomeDir(), '.myco-ts', `${tag}.sock`);
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const uid = process.getuid?.() ?? 0;
  return path.join('/tmp', `myco-td-${uid}-${tag}.sock`);
}

export function resolveGroveMetadataPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_METADATA_FILENAME);
}

export function resolveGroveConfigPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_CONFIG_FILENAME);
}

export function resolveGroveDbPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_DB_FILENAME);
}

/**
 * Inverse of `resolveGroveDbPath`: the Grove id a DB file belongs to,
 * read off its path (`.../groves/<groveId>/myco.db`). Same derivation
 * the daemon's cross-Grove ownership gate uses (db/client.ts
 * `assertOwnsDatabase`). Returns null for non-Grove DBs (in-memory,
 * test fixtures, arbitrary paths) so callers can treat Grove identity
 * as unknown rather than wrong.
 */
export function groveIdFromDbPath(dbPath: string): string | null {
  if (path.basename(dbPath) !== GROVE_DB_FILENAME) return null;
  const candidate = path.basename(path.dirname(dbPath));
  return isGroveEraId(candidate, 'grove') ? candidate : null;
}

export function resolveGroveVectorsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_VECTORS_FILENAME);
}

export function resolveGroveRegistryDir(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), GROVE_REGISTRY_DIRNAME);
}

export function resolveGroveProjectsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveRegistryDir(groveId, mycoHome), GROVE_PROJECTS_FILENAME);
}

export function resolveGroveRootsPath(groveId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveRegistryDir(groveId, mycoHome), GROVE_ROOTS_FILENAME);
}

/**
 * `~/.myco/groves/<groveId>/projects/<projectId>/` — the project-scoped
 * directory under its owning Grove. Hosts per-project artifacts that used to
 * live in `<projectRoot>/.myco/` (the capture buffer initially; archive
 * markers, per-project audit files later) so they ride with the Grove rather
 * than the project tree.
 *
 * Both `groveId` and `projectId` flow through their brand asserters before
 * being joined — Grove-id and project-id traversal attempts (`..`, absolute
 * paths) are rejected structurally, the same defense-in-depth as the other
 * Grove path resolvers.
 */
export function resolveGroveProjectDir(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): string {
  return path.join(
    resolveGroveDir(groveId, mycoHome),
    'projects',
    assertGroveEraId(projectId, 'project'),
  );
}

/**
 * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/` — global home for
 * a project's capture buffer files. One buffer dir per project (the legacy
 * `<projectRoot>/.myco/buffer/` shape carried over to the global tree).
 *
 * Hooks and the daemon's event dispatcher both write here; the reconciler
 * walks each registered project's buffer dir at startup. The legacy
 * project-local path remains as a read-side fallback during the brownfield
 * migration window.
 */
export function resolveProjectBufferDir(
  groveId: string,
  projectId: string,
  mycoHome = resolveMycoHome(),
): string {
  return path.join(resolveGroveProjectDir(groveId, projectId, mycoHome), 'buffer');
}

export function resolveProjectVaultDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), '.myco');
}

export function resolveProjectManifestPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, PROJECT_MANIFEST_FILENAME);
}

export function resolveProjectLocalManifestPath(projectVaultDir: string): string {
  return path.join(projectVaultDir, PROJECT_LOCAL_MANIFEST_FILENAME);
}

/**
 * `~/.myco/runtime.command` — single source of truth for which `myco`
 * binary the launcher (`myco-run.cjs`, `myco-cli.cjs`, `bin/myco.cjs`)
 * should exec. Absent file means "use whatever PATH resolves `myco` to."
 *
 * Machine-scoped because the daemon itself is now machine-scoped: there
 * is exactly one daemon per machine, and the runtime that backs it is a
 * machine-level choice, not a per-project one.
 */
export function resolveMachineRuntimeCommandPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, MACHINE_RUNTIME_COMMAND_FILENAME);
}

/**
 * The user's home directory. Single source of truth for the entire codebase —
 * every home-relative resolver, every doctor check, every API handler that
 * needs `~` funnels through this (directly, or via {@link expandHome}).
 *
 * Reads `$HOME` first so tests that override the home dir via
 * `process.env.HOME` actually take effect — Bun's `os.homedir()` resolves
 * via `getpwuid_r()` and IGNORES `$HOME` set after process launch, which
 * would otherwise let test pollution from the developer's real `~/...`
 * leak into a tmp-dir scoped test.
 *
 * Cross-platform: `$HOME` is unset on Windows (it uses `%USERPROFILE%`), so
 * the fallback to `os.homedir()` is what resolves there. A bare
 * `process.env.HOME ?? '/'` would read off the filesystem root on Windows.
 */
export function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

/**
 * Expand a leading `~` to the user's home dir. Pure path-string helper.
 * Home resolution funnels through {@link resolveHomeDir}.
 */
export function expandHome(value: string, homeDir?: string): string {
  // Non-`~` paths are returned verbatim — no home resolution happens,
  // so the sandbox sentinel has nothing to enforce. Returning early
  // here keeps stray MYCO_SANDBOX_ROOT settings from poisoning
  // unrelated call paths that pass already-absolute values.
  const needsExpansion = value === '~' || value.startsWith(`~${path.sep}`) || value.startsWith('~/');
  if (!needsExpansion) return value;
  const home = homeDir ?? resolveHomeDir();
  assertSandboxedHome(home);
  if (value === '~') return home;
  // Accept both `~/foo` (POSIX shape, what every manifest target uses)
  // and `~\foo` on Windows.
  return path.join(home, value.slice(2));
}

/**
 * Smoke-test sandbox enforcement. When `MYCO_SANDBOX_ROOT` is set, the
 * caller is claiming "this whole process is running inside an isolated
 * filesystem root." In that case `HOME` MUST resolve to a path inside
 * the sandbox — otherwise a smoke test that sandboxed `MYCO_HOME` (the
 * launcher state dir) but forgot to set `HOME` would write to the real
 * `~/.claude/settings.json`, `~/.cursor/hooks.json`, etc. via
 * manifest globalHooksTarget paths. That escape produced 30+ orphan
 * hook entries across five real symbiont config files — the bug this
 * gate exists to prevent recurring.
 *
 * Production calls (no MYCO_SANDBOX_ROOT) are unaffected.
 */
function assertSandboxedHome(home: string): void {
  const sandboxRoot = process.env.MYCO_SANDBOX_ROOT;
  if (!sandboxRoot) return;
  const resolvedRoot = path.resolve(sandboxRoot);
  const resolvedHome = path.resolve(home);
  const sep = path.sep;
  if (resolvedHome !== resolvedRoot && !resolvedHome.startsWith(resolvedRoot + sep)) {
    throw new Error(
      `MYCO_SANDBOX_ROOT=${sandboxRoot} is set but HOME=${home} resolves outside it. ` +
      `Smoke tests must point HOME inside MYCO_SANDBOX_ROOT so manifest `
      + `globalHooksTarget paths (~/.claude/settings.json, ~/.cursor/hooks.json, ...) `
      + `stay sandboxed alongside MYCO_HOME.`,
    );
  }
}
