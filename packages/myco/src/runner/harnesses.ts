/**
 * Every harness a worker can drive, and the facts that differ between them.
 *
 * Detection, the three drivers and `myco doctor` all read this one table, so a
 * fact about a harness is stated once. The facts that differ:
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
 *   grant decides every call a protocol driver is asked about, or what bounds a
 *   run where the harness never asks. A harness whose own configuration would
 *   approve a run's calls unasked, and that a run cannot be given a
 *   configuration of its own, is offered by no worker.
 * - **`accounting`** — the reported format, launch fallback, provider decoding
 *   and token coverage a driver reads for the run's accounting.
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
 * How a harness comes to ask before a call, or what bounds a run on a harness
 * that never asks.
 *
 * - `native`: a native driver pins the run's grant as the harness's own
 *   permissions, and the harness refuses whatever it does not allow.
 * - `sandbox`: the harness asks nothing and the run's grant does not apply. Its
 *   driver pins an operating-system sandbox that is the run's whole bound: what
 *   its commands may read, write and reach.
 * - `run-agent`: the harness asks only where its configuration says to, so a
 *   run starts in an agent of its own, supplied as configuration content in the
 *   variable `env`, under which every call asks; the session must report that
 *   agent as its mode. `extensionsOff` is the environment that keeps the
 *   extensions the machine installed out of the run's harness process, since an
 *   extension can answer a permission request itself.
 * - `run-home`: the harness asks for any call its configuration has not
 *   approved in advance, so a run reads a configuration directory of its own,
 *   named in the variable `env`, in which nothing is approved in advance.
 * - `unheld`: the harness approves in advance whatever its user's configuration
 *   approves, and a run cannot be given a configuration of its own, so no call
 *   it approved that way would reach the run's grant. No worker offers it.
 */
export type Asking =
  | { kind: 'native' }
  | { kind: 'sandbox' }
  | { kind: 'run-agent'; env: string; extensionsOff: Readonly<Record<string, string>> }
  | { kind: 'run-home'; env: string }
  | { kind: 'unheld' };

/**
 * Whether a source run on this harness may read Git history. `shim`: the
 * harness runs a shell command with the run's own `git` first on its PATH, so
 * the run is granted Git read commands. `none`: it does not, and a source run
 * reads its checkout through its file tools alone.
 */
export type SourceGit = 'shim' | 'none';

export interface HarnessAccounting {
  reported: 'claude-stream' | 'codex-session' | 'acp-session';
  modelSources: readonly string[];
  launchFallback: 'none' | 'resolved-config';
  primarySources?: readonly string[];
  modelVariants?: readonly { suffix: string; context: '1m' }[];
  zeroDollars?: 'reported' | 'unavailable';
  provider: { kind: 'environment'; default: string; selectors: readonly { variable: string; provider: string }[]; unknownIfSet: readonly string[] } | { kind: 'fixed'; id: string } | { kind: 'session-config'; default: string } | { kind: 'model-prefix' } | { kind: 'unavailable' };
  tokenScope: 'attempt' | 'unverified';
  lastResponseVersions?: readonly string[];
}

export interface Harness {
  id: string;
  binary: string;
  launch: LaunchShape;
  credential: CredentialProbe;
  isolation: Isolation;
  asking: Asking;
  sourceGit: SourceGit;
  accounting: HarnessAccounting;
}

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude-code',
    accounting: { reported: 'claude-stream', modelSources: ['system.init.model', 'assistant.message.model', 'result.modelUsage'], primarySources: ['system.init.model'], modelVariants: [{ suffix: '[1m]', context: '1m' }], zeroDollars: 'reported', launchFallback: 'none', provider: { kind: 'environment', default: 'anthropic', selectors: [{ variable: 'CLAUDE_CODE_USE_BEDROCK', provider: 'bedrock' }, { variable: 'CLAUDE_CODE_USE_VERTEX', provider: 'vertex' }, { variable: 'CLAUDE_CODE_USE_FOUNDRY', provider: 'foundry' }], unknownIfSet: ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_CLIENT_DATA_URL'] }, tokenScope: 'attempt' },
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
    accounting: { reported: 'codex-session', modelSources: ['session.turn_context.model'], launchFallback: 'resolved-config', provider: { kind: 'session-config', default: 'openai' }, tokenScope: 'attempt' },
    binary: 'codex',
    launch: { kind: 'native' },
    // A file holding none of the three is a logged-out file, not a login.
    credential: { kind: 'file', path: '~/.codex/auth.json', requires: ['OPENAI_API_KEY', 'tokens', 'personal_access_token'] },
    isolation: { kind: 'home', env: 'CODEX_HOME' },
    // It never asks: approvals would wait on a terminal nobody is at.
    asking: { kind: 'sandbox' },
    // Its driver holds a run to a sandbox rather than to the run's grant.
    sourceGit: 'none',
  },
  {
    id: 'opencode',
    accounting: { reported: 'acp-session', zeroDollars: 'unavailable', modelSources: ['session.models', 'session.configOptions', 'session.currentModelId'], launchFallback: 'none', provider: { kind: 'model-prefix' }, tokenScope: 'unverified', lastResponseVersions: ['1.18.21', '1.18.29'] },
    binary: 'opencode',
    launch: { kind: 'subcommand', args: ['acp'] },
    credential: { kind: 'file', path: '~/.local/share/opencode/auth.json', requires: [] },
    isolation: { kind: 'additive' },
    // Its default configuration allows every tool without asking, and a plugin
    // it loads can answer a permission request before the driver does.
    asking: { kind: 'run-agent', env: 'OPENCODE_CONFIG_CONTENT', extensionsOff: { OPENCODE_PURE: '1' } },
    sourceGit: 'shim',
  },
  {
    id: 'cursor',
    accounting: { reported: 'acp-session', zeroDollars: 'unavailable', modelSources: ['session.models', 'session.configOptions', 'session.currentModelId'], launchFallback: 'none', provider: { kind: 'unavailable' }, tokenScope: 'unverified' },
    binary: 'cursor-agent',
    launch: { kind: 'subcommand', args: ['acp'] },
    credential: { kind: 'command', args: ['status'] },
    isolation: { kind: 'additive' },
    // Its allow list and Run Everything mode live in its configuration
    // directory; its login lives in the keychain, outside it.
    asking: { kind: 'run-home', env: 'CURSOR_CONFIG_DIR' },
    // Its shell puts the system directories first on PATH before each command.
    sourceGit: 'none',
  },
  {
    id: 'antigravity',
    accounting: { reported: 'acp-session', zeroDollars: 'unavailable', modelSources: ['session.models', 'session.configOptions', 'session.currentModelId'], launchFallback: 'none', provider: { kind: 'unavailable' }, tokenScope: 'unverified' },
    binary: 'agy',
    launch: { kind: 'sidecar', binary: 'agy_acp_server.par' },
    credential: { kind: 'file', path: '~/.gemini/antigravity-cli/settings.json', requires: [] },
    isolation: { kind: 'additive' },
    // It reads its allow list from `~/.gemini/antigravity-cli/settings.json`,
    // and neither its CLI nor its protocol server is known to take a variable
    // or flag that moves it.
    asking: { kind: 'unheld' },
    // Its shell has not been seen reaching the run's git.
    sourceGit: 'none',
  },
];

const BY_ID = new Map(HARNESSES.map((h) => [h.id, h]));

/** Whether a run on this harness is held to its grant or its sandbox, and so whether a worker may offer it. */
export function offerable(harness: Harness): boolean {
  return harness.asking.kind !== 'unheld';
}

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
