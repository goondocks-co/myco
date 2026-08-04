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
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import { TEAM_AGENT_KEY_SECRET } from '@myco/constants.js';
import { KEYED_CLOUD_PROVIDER_ENV } from '@myco/agent/harness/provider-health.js';

import { hostEnable, type HostEnableDeps, type HostEnableOptions, type HostEnableResult } from './overlay.js';
import { writeTeamAgentKey, maskTeamAgentKey } from './team-secret.js';
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

// Mask moved to team-secret.ts with the writer extraction; re-exported so
// existing imports keep working.
export { maskTeamAgentKey } from './team-secret.js';

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
      hostname: options.hostname,
      // Pass-through, no silent default (rev 6): `hostEnable`'s own
      // explicit-choice resolution owns the refusal. The `--serve` installer
      // path is unaffected — it passes --designate-default explicitly.
      groveDesignation: options.groveDesignation,
      storageName: options.storageName,
    },
    deps,
  );

  let teamAgentKeyMasked: string | null = null;
  const teamAgentKey = options.teamAgentKey?.trim();
  if (teamAgentKey) {
    // ONE writer for the team key (team-secret.ts) — shared with the
    // host-admin enable route. The provider stays defaulted to 'anthropic'
    // HERE deliberately (documented in HOST_HELP as "default: anthropic";
    // the installer one-liner depends on it); the API route requires an
    // explicit provider, so new surfaces never inherit the silent default
    // that files a non-Anthropic team's key under ANTHROPIC_API_KEY.
    teamAgentKeyMasked = writeTeamAgentKey({
      servedGroveId: enable.servedGroveId,
      key: teamAgentKey,
      provider: options.teamKeyProvider ?? 'anthropic',
      mycoHome,
      lockNamespace: deps.lockNamespace,
    });
  }

  // No join command yet. It used to carry the headscale server URL and the
  // host's overlay authority — both gone — and the one-time key it embedded
  // was a headscale pre-auth key the daemon never validated. The invite flow
  // returns with the rebuilt enrollment route and the host's public URL.
  return { enable, joinCommand: null, teamAgentKeyMasked };
}

// Re-exported so `cli/host.ts` can re-print the composite's own vocabulary
// (`TEAM_AGENT_KEY_SECRET` env-var name) in its help text without importing
// `@myco/constants.js` a second time under a different name.
export { TEAM_AGENT_KEY_SECRET };
