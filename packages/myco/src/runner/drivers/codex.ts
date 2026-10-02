import { accountingEvents } from '../accounting.js';
/**
 * Codex, driven natively.
 *
 * `--json` writes one event per line and `turn.completed` is the terminal one,
 * carrying the turn's own token counts. Two shapes need care. An `error` item
 * arrives in the same stream as ordinary items and does **not** end the turn or
 * change the exit status, so treating one as a failure would fail runs that
 * completed. And the harness reads standard input even when given a prompt, so
 * the child's stdin is closed rather than left open.
 *
 * Isolation is a redirected configuration home rather than a flag: naming MCP
 * servers on the command line adds them to the servers the host already
 * configured, and a run's tools must be the run's alone. The redirect is
 * additive over the machine's own home rather than a replacement of it, because
 * that home holds the login as well as the configuration: a home holding only
 * the run's server is a run with no login, and the harness fails its turn on a
 * 401 from the model's API on a machine that is signed in.
 */
import type { WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { codexLaunchIdentity, codexSessionIdentity } from './codex-session.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { parse, stringify, type TomlTableWithoutBigInt } from 'smol-toml';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { locate } from '../detect.js';
import { credentialFile, harnessById, type Harness } from '../harnesses.js';
import type { Driver, RunEvent, RunSpec } from '../events.js';
import { MCP_SERVER_NAME } from '../mcp-config.js';
import { workerLogLine } from '../log.js';
import { freshRunHome } from './run-home.js';
import { confinedGitEnv } from './source-git.js';
import { resolveMycoHome } from '../../paths/home.js';
import { jsonLines, numberOf, recordOf, startHarness, stringOf } from './stream.js';

/** The table every MCP server this harness reads is declared under. */
const MCP_TABLE = 'mcp_servers';
/** The variable a Deployment hands this harness's key in. */
const CREDENTIAL_VARIABLE = HARNESS_CREDENTIALS.codex.variables[0]!;
/** The field this harness reads a key from in its login file, which is the only form it takes one in. */
const LOGIN_KEY_FIELD = 'OPENAI_API_KEY';

/**
 * What the run signs in as, in the home the run reads.
 *
 * A Deployment that holds a key for this harness is the run's login, and it has
 * to be written as a login: this harness reads a key from its login file and
 * not from the environment, so a key left in the environment alone signs
 * nothing in. The machine's own login is carried only where the Deployment
 * holds none — that slot is shared, so a Deployment holding a key for something
 * else entirely would otherwise take a signed-in machine's runs away from it.
 *
 * The machine's login is linked rather than copied: this harness writes its
 * login file in place, so a token it refreshes lands in the file the machine
 * signs in with rather than in a copy this then deletes, and no second copy of
 * a credential is written for anything to read.
 */
function carryLogin(home: string, spec: RunSpec, harness: Harness): void {
  const key = spec.credentialEnv[CREDENTIAL_VARIABLE];
  if (key !== undefined && key !== '') {
    writeFileSync(join(home, 'auth.json'), `${JSON.stringify({ [LOGIN_KEY_FIELD]: key }, null, 2)}\n`, { mode: 0o600 });
    return;
  }
  const login = credentialFile(harness);
  if (login !== null && existsSync(login)) symlinkSync(login, join(home, 'auth.json'));
}

/**
 * What `activeDeveloperDir` reads of the machine: the system it runs on, the
 * directory `xcode-select` names, what a path is and who owns it, and the
 * user's home. A test hands one of its own, so the checks below run on every
 * system rather than on macOS alone.
 */
export interface DeveloperDirProbe {
  platform: NodeJS.Platform;
  /** The directory the system names as the active developer directory, or null where it names none. */
  select(): string | null;
  /** A path's owner, permission bits and kind, or null where there is nothing at it. */
  stat(path: string): { uid: number; mode: number; directory: boolean; file: boolean } | null;
  /** The physical path of a path, which throws where there is nothing at it. */
  realpath(path: string): string;
  home: string;
  /** The user the worker runs as, who may own a developer directory it installed itself. */
  uid: number;
  /** The directories holding a secret no run may read: this harness's login directory and the Myco home. */
  closed: readonly string[];
}

/** The machine itself, as `activeDeveloperDir` reads it. */
export const SYSTEM_DEVELOPER_DIR_PROBE: DeveloperDirProbe = {
  platform: process.platform,
  select() {
    try {
      const selected = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return selected === '' ? null : selected;
    } catch {
      return null;
    }
  },
  stat(path) {
    try {
      const found = statSync(path);
      return { uid: found.uid, mode: found.mode, directory: found.isDirectory(), file: found.isFile() };
    } catch {
      return null;
    }
  },
  realpath: (path) => realpathSync(path),
  get home() { return homedir(); },
  uid: process.getuid?.() ?? -1,
  get closed() {
    const login = credentialFile(harnessById('codex')!);
    return [...(login === null ? [] : [dirname(login)]), resolveMycoHome()];
  },
};

/** The permission bits that let a group or everyone write a path. */
const WRITABLE_BY_OTHERS = 0o022;

/** Whether `path` is `root` or lies beneath it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The developer directory macOS runs `git` from, when it is safe to let a
 * source run read, or which check it failed: `/usr/bin/git` is a shim that
 * finds the real program under the active developer directory, and fails
 * before it reads anything when the sandbox hides that directory.
 *
 * Which directory that is, is the user's to choose (`xcode-select -s`,
 * `DEVELOPER_DIR`), and whatever it names the run's commands may read. So the
 * directory is granted only where it is a developer directory and nothing
 * more: a directory owned by root or by the user the worker runs as (an Xcode
 * installed from a `.xip`, a disk image or `xcodes` is the user's), that
 * nobody else can write, holding `usr/bin/git`, that is neither the root of
 * the filesystem nor the user's home, the run's own directory or a directory
 * above either — a grant of any of those reads what the rest of the profile
 * closes — and that neither is nor holds a directory in `closed`: a user's own
 * directory can sit in the home, and a `usr/bin/git` placed in the harness's
 * login directory would otherwise grant the run its login. `refused` is null on any other system and where none is selected,
 * which fail no check.
 */
export function developerDirVerdict(runDir: string, probe: DeveloperDirProbe = SYSTEM_DEVELOPER_DIR_PROBE): { dir: string } | { dir: null; refused: string | null } {
  if (probe.platform !== 'darwin') return { dir: null, refused: null };
  const selected = probe.select();
  if (selected === null) return { dir: null, refused: null };
  let dir: string;
  let home: string;
  let run: string;
  try {
    dir = probe.realpath(selected);
    home = probe.realpath(probe.home);
    run = probe.realpath(runDir);
  } catch {
    return { dir: null, refused: `${selected}, or the home or run directory, has no physical path` };
  }
  const found = probe.stat(dir);
  if (found === null || !found.directory) return { dir: null, refused: `${dir} is not a directory` };
  if (found.uid !== 0 && found.uid !== probe.uid) return { dir: null, refused: `${dir} is owned by neither root nor the user this worker runs as` };
  if ((found.mode & WRITABLE_BY_OTHERS) !== 0) return { dir: null, refused: `${dir} is writable by its group or others` };
  if (dir === sep || within(home, dir) || within(run, dir)) return { dir: null, refused: `${dir} is the filesystem root or holds the home or the run's directory` };
  const physical = (path: string): string => { try { return probe.realpath(path); } catch { return path; } };
  if (probe.closed.some((closed) => within(physical(closed), dir))) return { dir: null, refused: `${dir} is or holds the harness login's directory or the Myco home` };
  const git = probe.stat(join(dir, 'usr', 'bin', 'git'));
  return git !== null && git.file ? { dir } : { dir: null, refused: `${dir} holds no usr/bin/git` };
}

/** The developer directory a source run may read, or null (`developerDirVerdict`). */
export function activeDeveloperDir(runDir: string, probe: DeveloperDirProbe = SYSTEM_DEVELOPER_DIR_PROBE): string | null {
  return developerDirVerdict(runDir, probe).dir;
}

/** The permission profile a run's commands run under, and the only one its configuration defines. */
export const RUN_PERMISSIONS = 'myco_run';

/**
 * What a run's commands may touch, as the harness's sandbox holds them to it.
 *
 * This harness never asks before a call and the run's grant does not reach it,
 * so the sandbox is the run's whole bound: a command reads the system's own
 * minimal set and the run's directory, and writes nothing (a source run) or
 * only the run's directory; the temporary directories every command could
 * otherwise read and write are closed. Within the run's directory, the run's
 * configuration home and its MCP configuration are closed as well: they hold
 * the run's credentials, which are the harness's to read and not its
 * commands'. The harness's own program is readable, in the directory PATH
 * finds it in and the one it is installed in, since the harness runs a helper
 * of its own inside the same sandbox, by the path PATH gave it, to read the
 * run's instructions. A source run on macOS reads the active developer
 * directory as well, since the system's `git` runs from it
 * (`activeDeveloperDir`); no other run runs `git`, so no other run is given it.
 * A command reaches no network. Paths are physical, since the sandbox judges
 * the path a file really has.
 */
export function runFilesystem(spec: RunSpec, home: string, installed: string | null, developerDir: string | null): Record<string, string> {
  const source = spec.sourceReadOnly === true;
  return {
    ':minimal': 'read',
    ':slash_tmp': 'deny',
    ':tmpdir': 'deny',
    ...(installed === null ? {} : { [dirname(installed)]: 'read', [dirname(realpathSync(installed))]: 'read' }),
    ...(source && developerDir !== null ? { [developerDir]: 'read' } : {}),
    [realpathSync(spec.scratchDir)]: source ? 'read' : 'write',
    [realpathSync(home)]: 'deny',
    [realpathSync(spec.mcpConfigPath)]: 'deny',
  };
}

/**
 * The harness features a run never has, whatever the machine turned on: each
 * acts outside the sandbox `runFilesystem` describes or outside the run's
 * tools. Connectors and plugins bring tools and servers of their own, and so
 * do the features that install or suggest them. The browser and computer
 * features drive programs outside the sandbox. Image viewing reads a file in
 * the harness's own process rather than through a sandboxed command, and image
 * generation calls a service the run was not given. Hooks run the machine's
 * own commands at points in the turn.
 */
export const RUN_FEATURES_OFF = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_local_automation',
  'plugins',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'view_image',
] as const;

/**
 * Which of the harness's environment its commands see: its own default, which
 * leaves out every variable named like a key, secret or token. The harness's
 * environment holds the run's credential where the Deployment handed one, and
 * a machine policy that keeps those variables would hand it to every command.
 */
export const RUN_SHELL_ENVIRONMENT = { inherit: 'all', ignore_default_excludes: false } as const;

/**
 * What a source run's commands are told besides, so its `git` runs in the
 * sandbox: the sandbox hides the user's home, and Git stops at a global
 * configuration it cannot open rather than reading on without it, and warns at
 * an ignore or attributes file it cannot open, so a run's Git runs under the
 * confinement the other harnesses' `git` sets (`confinedGitEnv`) and reads the
 * checkout's own configuration and nothing of the machine's. On
 * macOS the shim is pointed at the developer directory the run was granted,
 * so the directory it runs from is the one `activeDeveloperDir` checked, and
 * that directory's own `git` comes first on PATH, which holds only in a shell
 * that is not a login shell (`allow_login_shell`). No other run runs `git`, so
 * no other run is told any of it.
 */
export function sourceGitEnvironment(developerDir: string | null, path: string = process.env.PATH ?? ''): Record<string, string> {
  return {
    ...confinedGitEnv(),
    ...(developerDir === null ? {} : {
      DEVELOPER_DIR: developerDir,
      // Its own `git` first: the `/usr/bin` shim runs xcrun, which warns on every call that it cannot write its cache
      // in the temporary directory the sandbox closes.
      PATH: path === '' ? join(developerDir, 'usr', 'bin') : `${join(developerDir, 'usr', 'bin')}${delimiter}${path}`,
    }),
  };
}

/**
 * The configuration the run reads: the machine's own, with the run's MCP server
 * in place of every other and the settings a queued run cannot inherit.
 *
 * What the operator set is what a run on their machine behaves under, and it is
 * carried as it stands — `[model_providers]` and the headers one can hold
 * included, into a directory only the worker's user can read. Their servers are
 * the exception: a run's tools are the run's alone, and a server the operator
 * configured carries the operator's own headers besides.
 *
 * The rest are the run's rather than the machine's. There is nobody at a
 * terminal to answer an approval, so a run that asked for one would hang until
 * its budget ended it. A run queued from elsewhere is bounded by the sandbox
 * `runFilesystem` describes, rather than by what an operator allows themselves
 * sitting in front of the machine: `danger-full-access` on a laptop is a setting
 * for the person holding it, and so is any permission profile they defined. The
 * harness's own web search, which no sandbox holds, is off, as are the features
 * in `RUN_FEATURES_OFF`, and its commands see the environment
 * `RUN_SHELL_ENVIRONMENT` describes rather than the machine's policy.
 *
 * It is read and written through a parser: this file is the operator's, and a
 * scan for the lines that look like server declarations mistakes a multi-line
 * string that contains one for the real thing.
 */
function runConfig(spec: RunSpec, harness: Harness, home: string, probe: DeveloperDirProbe, log: (line: string) => void): string {
  const login = credentialFile(harness);
  // A harness keeps its login inside its configuration home, so the directory
  // holding the declared login file is the home this run is additive over.
  const machinePath = login === null ? null : join(dirname(login), 'config.toml');
  const machine = (machinePath !== null && existsSync(machinePath)
    ? parse(readFileSync(machinePath, 'utf8'))
    : {}) as Record<string, unknown>;
  const profile = typeof machine.profile === 'string' ? recordOf(recordOf(machine.profiles)?.[machine.profile]) : null;
  for (const key of ['model', 'model_provider']) {
    if (profile?.[key] !== undefined) machine[key] = profile[key];
  }
  // The run config has no active machine profile after its provider choice is carried to the root.
  delete machine.profile;
  delete machine.profiles;
  if (spec.profile !== undefined) {
    machine.model = spec.profile.model;
    if (spec.profile.effort === null) delete machine.model_reasoning_effort;
    else machine.model_reasoning_effort = spec.profile.effort;
  }
  machine.approval_policy = 'never';
  // The run's permission profile is the run's whole sandbox, so the machine's
  // own sandbox settings are dropped rather than left beside it.
  delete machine.sandbox_mode;
  delete machine.sandbox_workspace_write;
  machine.default_permissions = RUN_PERMISSIONS;
  const source = spec.sourceReadOnly === true;
  const verdict = source ? developerDirVerdict(spec.scratchDir, probe) : { dir: null, refused: null };
  if (verdict.dir === null && verdict.refused !== null) log(`a source run's git cannot run here, so the run reads no git history: ${verdict.refused}`);
  const developerDir = verdict.dir;
  machine.permissions = { [RUN_PERMISSIONS]: { filesystem: runFilesystem(spec, home, locate(harness.binary), developerDir) } };
  machine.web_search = 'disabled';
  machine.features = { ...recordOf(machine.features), ...Object.fromEntries(RUN_FEATURES_OFF.map((feature) => [feature, false])) };
  machine.shell_environment_policy = { ...RUN_SHELL_ENVIRONMENT, ...(source ? { set: sourceGitEnvironment(developerDir) } : {}) };
  // A login shell reads the system's profile, and on macOS that puts `/usr/bin` back ahead of the PATH set above.
  if (source) machine.allow_login_shell = false;

  // The run's connection is authored once, in `mcp-config.ts`. This reads that
  // file and restates it in the language this harness configures servers in,
  // rather than naming the server, the URL or the headers a second time.
  const config = JSON.parse(readFileSync(spec.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
  const server = config.mcpServers[MCP_SERVER_NAME]!;
  // Every server the machine declared, under a header or at the root, is one
  // value under one key: the run's server replaces the lot rather than joining it.
  machine[MCP_TABLE] = { [MCP_SERVER_NAME]: { url: server.url, http_headers: server.headers } };
  return stringify(machine as TomlTableWithoutBigInt);
}

/** The configuration home a run reads, built where the run's own files are (`run-home.ts`). */
function runHome(spec: RunSpec, harness: Harness, probe: DeveloperDirProbe, log: (line: string) => void): string {
  const home = freshRunHome(spec.scratchDir, 'codex-home');
  carryLogin(home, spec, harness);
  writeFileSync(join(home, 'config.toml'), runConfig(spec, harness, home, probe, log), { mode: 0o600 });
  return home;
}

/** A tool call's outcome in the driver's words: Codex says `completed` and `failed`, and anything else is a call still going. */
function toolStatus(status: string | null): 'started' | 'ok' | 'error' {
  return status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'started';
}

/**
 * The driver, reading the machine through `probe` for the developer directory a source run's `git` needs, and
 * saying in the worker's log which check a refused one failed.
 */
export function codexDriverWith(probe: DeveloperDirProbe, log: (line: string) => void = (line) => { console.log(workerLogLine(line)); }): Driver {
  return {
    id: 'codex',
    run: (spec, signal) => runCodex(spec, signal, probe, log),
  };
}

export const codexDriver: Driver = codexDriverWith(SYSTEM_DEVELOPER_DIR_PROBE);

async function* runCodex(spec: RunSpec, signal: AbortSignal, probe: DeveloperDirProbe, log: (line: string) => void): AsyncIterable<RunEvent> {
  const harness = harnessById('codex')!;
  const home = runHome(spec, harness, probe, log);
  const configured = parse(readFileSync(join(home, 'config.toml'), 'utf8')) as Record<string, unknown>;
  const launchEvents = accountingEvents(() => {
    const identity = codexLaunchIdentity(harness, configured);
    return identity === null ? [] : [{ kind: 'identity', identity }];
  });
  yield* launchEvents;
  const launched = launchEvents.find((event) => event.kind === 'identity')?.identity ?? null;
  const env = { ...spec.credentialEnv, ...(harness.isolation.kind === 'home' ? { [harness.isolation.env]: home } : {}) };
  const selection = launched === null || launched.status === 'unknown' ? [] : [
    '-c', `model=${JSON.stringify(launched.primary.model)}`,
    ...(launched.primary.provider === undefined ? [] : ['-c', `model_provider=${JSON.stringify(launched.primary.provider)}`]),
  ];
  const started = startHarness(harness.binary, ['exec', '--json', '--skip-git-repo-check', ...selection, spec.prompt], { cwd: spec.scratchDir, env, signal });

  let terminal: Extract<RunEvent, { kind: 'ended' }> | null = null;
  let threadId: string | null = null;
  let accounting: WorkerUsage | null = null;
  for await (const line of jsonLines(started.lines)) {
    const type = stringOf(line.type);
    if (type === 'thread.started') {
      threadId = stringOf(line.thread_id);
      yield { kind: 'started', harness: harness.id, sessionId: threadId };
    } else if (type === 'item.completed') {
      const item = recordOf(line.item);
      const itemType = item === null ? null : stringOf(item.type);
      // An error item is one item among many, never the end of the turn and
      // never a call: only a tool's own item is a call, named by its tool.
      if (itemType === 'agent_message') yield { kind: 'message', role: 'assistant', text: stringOf(item?.text) ?? '' };
      else if (itemType === 'mcp_tool_call') yield { kind: 'tool_call', name: stringOf(item?.tool) ?? 'mcp', status: toolStatus(stringOf(item?.status)) };
    } else if (type === 'turn.completed') {
      const usage = recordOf(line.usage);
      accounting = {
        inputTokens: usage === null ? null : numberOf(usage.input_tokens),
        outputTokens: usage === null ? null : numberOf(usage.output_tokens),
        cachedTokens: usage === null ? null : numberOf(usage.cached_input_tokens),
        costUsd: null,
      };
      terminal = { kind: 'ended', stop: 'end_turn', detail: null };
    } else if (type === 'turn.failed') {
      terminal = { kind: 'ended', stop: 'error', detail: stringOf(recordOf(line.error)?.message) };
    }
  }
  const code = await started.exit;
  yield* accountingEvents(() => {
    const identity = codexSessionIdentity(harness, home, spec.scratchDir, threadId, accounting, launched);
    return identity === null ? [] : [{ kind: 'identity', identity }];
  });
  if (accounting !== null) yield { kind: 'usage', ...accounting };
  yield terminal ?? { kind: 'ended', stop: 'error', detail: `the harness completed no turn and exited ${code}: ${started.errorText().slice(0, 2000)}` };
}
