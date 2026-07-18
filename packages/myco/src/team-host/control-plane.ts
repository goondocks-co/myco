/**
 * Operator control-plane primitives: the "is this machine a Team Host, and
 * if so what's its headscale invocation base" resolution, and one-time
 * setup-key minting.
 *
 * `mintSetupKey` is imported by `team-host/compose.ts` (join-command
 * composition) and `cli/host.ts` (the `myco host` CLI). `headscaleBase`,
 * `ControlPlaneDeps`, and `NotAHostError` back `mintSetupKey` and are
 * exported for any other control-plane op built on the same seams.
 */
import { appendHostAction } from '@myco/host/action-log.js';
import { resolveHostControlDir } from '@myco/grove/paths.js';

import type { CommandRunner } from './binaries.js';
import { headscaleLayout, mintPreauthKey } from './headscale-config.js';
import { realRunner } from './run.js';
import { readHostState, type HostState } from './state.js';

/** Seams every control-plane op shares. Defaults are the real implementations. */
export interface ControlPlaneDeps {
  runner?: CommandRunner;
  /** The host state (headscale bin, config path, user). Default: on-disk state. */
  state?: HostState | null;
  /** The host-control home (action log + headscale layout). Default: machine-global. */
  controlDir?: string;
}

/** Thrown when a control-plane op runs on a machine that is not a Team Host. */
export class NotAHostError extends Error {
  constructor() {
    super('This machine is not a Team Host — run `myco host enable` first.');
    this.name = 'NotAHostError';
  }
}

/** Resolve the headscale invocation base (bin + config) from host state, or throw. */
export function headscaleBase(deps: ControlPlaneDeps): { bin: string; configPath: string; user: string; controlDir: string } {
  const controlDir = deps.controlDir ?? resolveHostControlDir();
  const state = deps.state === undefined ? readHostState() : deps.state;
  if (!state) throw new NotAHostError();
  return {
    bin: state.headscale_bin,
    configPath: headscaleLayout(controlDir).configPath,
    user: state.headscale_user,
    controlDir,
  };
}

/**
 * Mint a ONE-TIME setup key for the operator to hand a joiner (spec §8). Wraps
 * {@link mintPreauthKey} (`headscale preauthkeys create`). Logs the mint
 * (user + expiration) — NEVER the key value.
 */
export async function mintSetupKey(
  options: { expiration?: string } = {},
  deps: ControlPlaneDeps = {},
): Promise<string> {
  const base = headscaleBase(deps);
  const runner = deps.runner ?? realRunner;
  const expiration = options.expiration ?? '1h';
  const key = await mintPreauthKey({
    headscaleBin: base.bin,
    configPath: base.configPath,
    user: base.user,
    expiration,
    runner,
  });
  appendHostAction({ action: 'key-mint', subject: base.user, detail: { expiration } }, base.controlDir);
  return key;
}
