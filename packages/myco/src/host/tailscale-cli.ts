/**
 * The ONE way to invoke the `tailscale` CLI against a Myco-owned tailscaled
 * instance (Overlay Coexistence spec §7.1).
 *
 * WHY THIS EXISTS — two live defects shared one root cause: nothing owned
 * "how do you invoke tailscale", so each call site re-decided and two got it
 * wrong. Both invoked the binary with NO `--socket`, which means the ambient
 * daemon — on a machine with vendor Tailscale installed, that is the VENDOR
 * daemon:
 *
 *   · `team-host/overlay.ts` ran `tailscale ip -4` unsocketed during
 *     `host enable`. On a coexistence box that returns the VENDOR tailnet's
 *     100.64 address, which passes the overlay-range check, so enable logged
 *     "already on the overlay — skipping join", NEVER joined Myco's headscale,
 *     and persisted the vendor address as `host_serve.overlay_address`. A
 *     silent cross-tailnet misconfiguration on exactly the machine the
 *     coexistence invariant exists to protect.
 *   · `tailscale up` in the same flow, likewise unsocketed.
 *
 * The member overlay had it right all along (`--socket` on every call); this
 * module is that discipline made structural. A {@link TailscaleCli} cannot be
 * constructed without a socket path, so "forgot the socket" stops being a
 * reachable state rather than a thing reviewers must catch.
 *
 * SCOPE — Myco-owned instances only. There is exactly ONE sanctioned invocation
 * of the ambient/vendor `tailscale`: the external-MCP Funnel containment runner
 * (`daemon/external-listener.ts`). That one is deliberate and cannot use this
 * module — Tailscale Funnel is a Tailscale-cloud feature that headscale does
 * not implement (it serves no cert endpoint, the same reason HTTPS `serve`
 * 501s against it), so external MCP inherently rides the operator's OWN vendor
 * tailnet. Pointing it at a Myco socket would break the feature outright. It is
 * allowlisted in `tests/meta/no-vendor-tailscale-paths.test.ts` and reached
 * only when external MCP is actually configured (the `requiresContainment`
 * guard in `daemon/external-mcp-containment.ts`), never on a clean machine.
 */
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';

import type { CommandRunner } from './overlay-binaries.js';

export interface TailscaleCliInput {
  runner: CommandRunner;
  /** The Myco-provisioned `tailscale` binary. */
  tailscaleBin: string;
  /** THIS instance's private control socket. Required — that is the point. */
  socketPath: string;
}

export interface TailscaleCli {
  /** Run a `tailscale` subcommand against this instance's socket. */
  run(args: string[], opts?: { input?: string; timeoutMs?: number }): Promise<{ stdout: string; exitCode: number }>;
  /**
   * `tailscale ip -4` → the first line, iff it is a 100.64/10 address, else
   * `null`. Keyed on THIS instance's socket, so it reports THIS tailnet only —
   * never the vendor daemon's.
   */
  overlayIp(): Promise<string | null>;
}

/**
 * Bind a {@link CommandRunner} to one Myco tailscaled instance. Every call the
 * returned object makes carries `--socket=<socketPath>` ahead of the
 * subcommand, which is where tailscale expects a global flag.
 */
export function createTailscaleCli(input: TailscaleCliInput): TailscaleCli {
  const { runner, tailscaleBin, socketPath } = input;
  if (!socketPath.trim()) {
    throw new Error(
      'createTailscaleCli requires a socket path — an unsocketed `tailscale` call reaches the ambient '
      + '(possibly vendor) daemon. See the Overlay Coexistence spec §7.1.',
    );
  }
  const run: TailscaleCli['run'] = (args, opts) =>
    runner.run(tailscaleBin, ['--socket', socketPath, ...args], opts);

  return {
    run,
    async overlayIp() {
      const res = await run(['ip', '-4']);
      if (res.exitCode !== 0) return null;
      const line = res.stdout.split('\n').map((l) => l.trim()).find(Boolean);
      return line && isOverlayRangeAddress(line) ? line : null;
    },
  };
}
