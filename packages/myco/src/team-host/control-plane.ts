/**
 * Operator control-plane primitives shared by the `myco host` CLI and the
 * legacy `myco-team host` operator surface: the "is this machine a Team
 * Host, and if so what's its headscale invocation base" resolution, and
 * one-time setup-key minting.
 *
 * `headscaleBase`/`ControlPlaneDeps`/`NotAHostError` are also consumed by
 * `packages/myco-team/src/host/devices.ts` (devices list/evict, bearer
 * rotate) — those ops are localhost-CLI-only by construction (spec §8:
 * "Operator (host localhost): the control plane, exclusively") and are not
 * (yet) exposed as `myco host` subcommands, so their home stays in
 * `myco-team`; this module is theirs to import rather than duplicate.
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
