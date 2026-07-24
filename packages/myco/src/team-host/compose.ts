/**
 * `host enable --designate-default --emit-join` composite — the `--serve`
 * installer flag's own orchestrator (server-mode design spec §3 steps 4-6).
 *
 * enable (Task 3's default designation path) → optionally seed the team's
 * provider key into the served Grove's secrets → mint a one-time setup key
 * (prompting first on a re-run) → the complete ready-to-paste join command.
 * Seam-injectable the same way {@link hostEnable} is so it unit-tests with no
 * network, no sudo, and no real TTY.
 */
import { resolveGroveDir, resolveMycoHome } from '@myco/grove/paths.js';
import { resolveGlobalDaemonPort } from '@myco/daemon/service-state.js';
import { writeSecret } from '@myco/config/secrets.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import { TEAM_AGENT_KEY_SECRET } from '@myco/constants.js';
import { KEYED_CLOUD_PROVIDER_ENV } from '@myco/agent/harness/provider-health.js';

import { hostEnable, type HostEnableDeps, type HostEnableOptions, type HostEnableResult } from './overlay.js';
import { mintSetupKey } from './control-plane.js';
import { readHostState } from './state.js';

const VALID_TEAM_KEY_PROVIDERS = Object.keys(KEYED_CLOUD_PROVIDER_ENV) as Array<keyof typeof KEYED_CLOUD_PROVIDER_ENV>;

/**
 * Validates `--team-key-provider` against `KEYED_CLOUD_PROVIDER_ENV`'s OWN
 * properties — never the bare `in` operator, which also matches inherited
 * `Object.prototype` keys (`toString`, `hasOwnProperty`, …) and would let a
 * typo like that silently pass validation. Returns `undefined` when no flag
 * was supplied (the `hostEnableAndEmitJoin` anthropic default applies
 * downstream); throws when a flag WAS supplied but isn't a recognized
 * provider, so the CLI can fail loudly — before any enable/mint/store side
 * effect — instead of silently storing the key under the wrong provider's
 * env name (the permanent keyless-suppression hazard this route class
 * exists to prevent).
 */
export function resolveTeamKeyProviderFlag(flagValue: string | undefined): keyof typeof KEYED_CLOUD_PROVIDER_ENV | undefined {
  if (flagValue === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(KEYED_CLOUD_PROVIDER_ENV, flagValue)) {
    throw new Error(
      `Unrecognized --team-key-provider "${flagValue}". Valid providers: ${VALID_TEAM_KEY_PROVIDERS.join(', ')}.`,
    );
  }
  return flagValue as keyof typeof KEYED_CLOUD_PROVIDER_ENV;
}

/** First-8+last-4 masking, matching the masked-echo contract secrets are
 *  never printed in full under (server-mode design spec §5/§6). */
export function maskTeamAgentKey(secret: string): string {
  const PREFIX = 8;
  const SUFFIX = 4;
  if (secret.length <= PREFIX + SUFFIX) return '*'.repeat(secret.length);
  return `${secret.slice(0, PREFIX)}${'*'.repeat(secret.length - PREFIX - SUFFIX)}${secret.slice(-SUFFIX)}`;
}

/** Real TTY y/N prompt. A non-TTY caller (CI, a piped install script) gets
 *  `false` — never a hang waiting on stdin. */
async function defaultConfirmRemint(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message} [y/N] `, (reply) => resolve(reply));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export interface ComposeEnableOptions extends HostEnableOptions {
  /**
   * The team's LLM provider API key (server-mode design spec §5), optionally
   * supplied via env `MYCO_TEAM_AGENT_KEY` (the TRANSPORT name only — see
   * {@link TEAM_AGENT_KEY_SECRET}). Lands in the served Grove's
   * `secrets.env` via `writeSecret` under the PROVIDER-STANDARD env name
   * ({@link teamKeyProvider}, `KEYED_CLOUD_PROVIDER_ENV`) — NEVER in YAML,
   * and never under the transport name itself (a real dispatch never reads
   * that name).
   */
  teamAgentKey?: string;
  /**
   * Which provider's standard env name the key is stored under (default:
   * `'anthropic'` — the API-key path spec §5 documents). Only meaningful
   * when `teamAgentKey` is supplied.
   */
  teamKeyProvider?: keyof typeof KEYED_CLOUD_PROVIDER_ENV;
  /** One-time setup-key lifetime for the emitted join command. Default: `mintSetupKey`'s own default (`'1h'`). */
  setupKeyExpiration?: string;
}

export interface ComposeEnableDeps extends HostEnableDeps {
  lockNamespace?: PerUserLockNamespace;
  /**
   * Confirm before minting a fresh one-time setup key when this machine was
   * ALREADY a Team Host before this call (server-mode design spec §3:
   * "prompts before minting a fresh join key … not a silent side effect of
   * every re-run"). Default: a real TTY y/N prompt. Return true to proceed
   * with a fresh mint.
   */
  confirmRemint?: (message: string) => Promise<boolean>;
}

export interface ComposeEnableResult {
  enable: HostEnableResult;
  /** The full ready-to-paste `myco join …` command, or null when the operator declined re-mint on a re-run. */
  joinCommand: string | null;
  /** Masked (first-8+last-4) echo of the team key that was written, or null when none was supplied. */
  teamAgentKeyMasked: string | null;
}

/**
 * `host enable --designate-default --emit-join`: enable (Task 3's default
 * designation path) → optionally seed the team's provider key into the
 * served Grove's secrets → mint a one-time setup key (prompting first on a
 * re-run) → the complete ready-to-paste join command. This is the `--serve`
 * installer flag's own orchestrator (server-mode design spec §3 steps 4-6),
 * seam-injectable the same way {@link hostEnable} is so it unit-tests with no
 * network, no sudo, and no real TTY.
 */
export async function hostEnableAndEmitJoin(
  options: ComposeEnableOptions,
  deps: ComposeEnableDeps = {},
): Promise<ComposeEnableResult> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  // Captured BEFORE `hostEnable` runs — "re-run" means this machine was
  // already a Team Host, not that this specific composite call happened
  // before (a `host enable` first, then `--emit-join` later, still counts).
  const alreadyEnabled = readHostState() !== null;

  const enable = await hostEnable(
    {
      serverUrl: options.serverUrl,
      hostname: options.hostname,
      listenAddr: options.listenAddr,
      headscaleUser: options.headscaleUser,
      keyExpiration: options.keyExpiration,
      groveDesignation: options.groveDesignation ?? 'default',
    },
    deps,
  );

  let teamAgentKeyMasked: string | null = null;
  const teamAgentKey = options.teamAgentKey?.trim();
  if (teamAgentKey) {
    const groveDir = resolveGroveDir(enable.servedGroveId, mycoHome);
    // Stored under the PROVIDER-STANDARD env name (never TEAM_AGENT_KEY_SECRET,
    // which is only the CLI-flag/env-var transport name a real dispatch never
    // reads — see TEAM_AGENT_KEY_SECRET's docstring, constants.ts). Default
    // provider 'anthropic' per spec §5's API-key path.
    const provider = options.teamKeyProvider ?? 'anthropic';
    const envKey = KEYED_CLOUD_PROVIDER_ENV[provider]?.[0];
    if (!envKey) {
      // Unreachable in practice: `resolveTeamKeyProviderFlag` already
      // validates `--team-key-provider` against `KEYED_CLOUD_PROVIDER_ENV`'s
      // own keys before this composite ever runs, so `provider` is always a
      // recognized key here. A silent `?? KEYED_CLOUD_PROVIDER_ENV.anthropic`
      // fallback would, if this invariant were ever violated upstream, store
      // the key under anthropic's env name while the caller believes it went
      // to `provider` — a keyless-suppression hazard this route class exists
      // to prevent. Fail loudly instead.
      throw new Error(`Invariant violation: no env name registered for team key provider "${provider}" in KEYED_CLOUD_PROVIDER_ENV.`);
    }
    writeSecret(groveDir, envKey, teamAgentKey, deps.lockNamespace);
    teamAgentKeyMasked = maskTeamAgentKey(teamAgentKey);
  }

  let shouldMint = true;
  if (alreadyEnabled) {
    const confirm = deps.confirmRemint ?? defaultConfirmRemint;
    shouldMint = await confirm('Team Host is already enabled on this machine. Mint a fresh one-time join key?');
  }
  if (!shouldMint) {
    return { enable, joinCommand: null, teamAgentKeyMasked };
  }

  const key = await mintSetupKey({ expiration: options.setupKeyExpiration }, { runner: deps.runner });
  const port = resolveGlobalDaemonPort(mycoHome);
  const joinCommand = `myco join ${enable.hostId} --key ${key} --server-url ${enable.serverUrl} --overlay-address ${enable.overlayAddress}:${port}`;
  return { enable, joinCommand, teamAgentKeyMasked };
}

// Re-exported so `cli/host.ts` can re-print the composite's own vocabulary
// (`TEAM_AGENT_KEY_SECRET` env-var name) in its help text without importing
// `@myco/constants.js` a second time under a different name.
export { TEAM_AGENT_KEY_SECRET };
