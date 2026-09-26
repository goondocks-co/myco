/**
 * Every harness a worker can drive, and the six facts that differ between them.
 *
 * Detection, the three drivers and `myco doctor` all read this one table, so a
 * fact about a harness is stated once. The six that differ:
 *
 * - **`binary`** — what to look for on PATH.
 * - **`launch`** — three shapes, not two. A harness may speak the protocol
 *   through its own binary (`opencode acp`, `cursor-agent acp`), through no
 *   protocol at all so a native driver reads its own stream (Claude Code,
 *   Codex), or through a sidecar binary its vendor ships separately.
 * - **`credential`** — where the harness keeps its login. Detection reads a
 *   file or asks the binary; it never asks the network, and a registry entry
 *   never answers it, so the probe is always of the tool itself.
 * - **`isolation`** — how a per-run configuration becomes the harness's ONLY
 *   source of tools. This differs per harness and only one of the three is
 *   airtight, which is why it is a field rather than one rule applied thrice.
 * - **`asking`** — how a harness is made to ask before a call, so the run's
 *   grant decides every call a protocol driver is asked about.
 * - **`sourceGit`** — whether a source run's shell commands reach the run's
 *   own `git`, so the grant offers Git reads only where they can be held to
 *   reads of the checkout.
 */

import { expandHome } from '../paths/home.js';

/** How a harness is started so it speaks the agent protocol, or that it does not speak it at all. */
export type LaunchShape =
  | { kind: 'native' }
  | { kind: 'subcommand'; args: readonly string[] }
  | { kind: 'sidecar'; binary: string };

/** Where a harness keeps its login, and how a probe reads it without printing it. */
export type CredentialProbe =
  | { kind: 'file'; path: string; requires: readonly string[] }
  | { kind: 'command'; args: readonly string[] }
  /** A file, with a command to fall back to where the platform keeps the value in its keyring instead. */
  | { kind: 'file-or-command'; path: string; requires: readonly string[]; args: readonly string[] };

/**
 * How a per-run configuration becomes the harness's only tool source.
 *
 * `flag` is airtight: the harness is told to use this configuration and ignore
 * every other. `home` is airtight for the TOOL surface, by giving the harness a
 * configuration directory of its own: what the machine configured is carried
 * into it, its login included, and the servers it configured are not, so no
 * server but the run's is in reach. What a home does not isolate is the rest of
 * that configuration, which flows into a run queued from elsewhere, so a driver
 * that redirects a home pins what a queued run cannot inherit. `additive` is
 * neither: the run's servers are added to whatever the harness already has, and
 * a worker cannot make that exclusive from outside.
 */
export type Isolation =
  | { kind: 'flag'; args: readonly string[] }
  | { kind: 'home'; env: string }
  | { kind: 'additive' };

/**
 * How a harness comes to ask before a call.
 *
 * `native`: a native driver pins the harness's permissions itself. `default`:
 * the harness asks for any call its own configuration has not approved in
 * advance. `run-agent`: the harness asks only where its configuration says to,
 * so a run starts in an agent of its own, supplied as configuration content in
 * the variable `env`, under which every call asks; the session must report
 * that agent as its mode.
 */
export type Asking =
  | { kind: 'native' }
  | { kind: 'default' }
  | { kind: 'run-agent'; env: string };

/**
 * Whether a source run on this harness may read Git history. `shim`: the
 * harness runs a shell command with the run's own `git` first on its PATH, so
 * the run is granted Git read commands. `none`: it does not, and a source run
 * reads its checkout through its file tools alone.
 */
export type SourceGit = 'shim' | 'none';

export interface Harness {
  id: string;
  binary: string;
  launch: LaunchShape;
  credential: CredentialProbe;
  isolation: Isolation;
  asking: Asking;
  sourceGit: SourceGit;
}

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude-code',
    binary: 'claude',
    launch: { kind: 'native' },
    // The value lives in the OS keyring on macOS and in the file elsewhere, so
    // the file answers where it exists and the binary answers where it does not.
    credential: { kind: 'file-or-command', path: '~/.claude/.credentials.json', requires: ['claudeAiOauth', 'accessToken'], args: ['auth', 'status'] },
    isolation: { kind: 'flag', args: ['--strict-mcp-config'] },
    asking: { kind: 'native' },
    sourceGit: 'shim',
  },
  {
    id: 'codex',
    binary: 'codex',
    launch: { kind: 'native' },
    // A file holding none of the three is a logged-out file, not a login.
    credential: { kind: 'file', path: '~/.codex/auth.json', requires: ['OPENAI_API_KEY', 'tokens', 'personal_access_token'] },
    isolation: { kind: 'home', env: 'CODEX_HOME' },
    asking: { kind: 'native' },
    // Its driver holds a run to a sandbox rather than to the run's grant.
    sourceGit: 'none',
  },
  {
    id: 'opencode',
    binary: 'opencode',
    launch: { kind: 'subcommand', args: ['acp'] },
    credential: { kind: 'file', path: '~/.local/share/opencode/auth.json', requires: [] },
    isolation: { kind: 'additive' },
    // Its default configuration allows every tool without asking.
    asking: { kind: 'run-agent', env: 'OPENCODE_CONFIG_CONTENT' },
    sourceGit: 'shim',
  },
  {
    id: 'cursor',
    binary: 'cursor-agent',
    launch: { kind: 'subcommand', args: ['acp'] },
    credential: { kind: 'command', args: ['status'] },
    isolation: { kind: 'additive' },
    asking: { kind: 'default' },
    // Its shell puts the system directories first on PATH before each command.
    sourceGit: 'none',
  },
  {
    id: 'antigravity',
    binary: 'agy',
    launch: { kind: 'sidecar', binary: 'agy_acp_server.par' },
    credential: { kind: 'file', path: '~/.gemini/antigravity-cli/settings.json', requires: [] },
    isolation: { kind: 'additive' },
    asking: { kind: 'default' },
    sourceGit: 'shim',
  },
];

const BY_ID = new Map(HARNESSES.map((h) => [h.id, h]));

/** The harness this id names, or null when the worker serves none by that name. */
export function harnessById(id: string): Harness | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The absolute path of the file this harness keeps its login in, or null where
 * only its binary can answer.
 *
 * The declaration above is the one place that path is written. Detection reads
 * a login through this, and so does a driver that has to carry one into a run,
 * so a harness that moves its credential file is followed everywhere by the
 * edit that moves it here.
 */
export function credentialFile(harness: Harness): string | null {
  const probe = harness.credential;
  if (probe.kind === 'command') return null;
  return expandHome(probe.path);
}
