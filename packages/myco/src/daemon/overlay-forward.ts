/**
 * The overlay's inbound bridge: tailscaled's persisted `serve --tcp` forward
 * from `<overlay-ip>:P` to the daemon's loopback overlay listener on
 * `127.0.0.1:P` (Overlay Coexistence spec §8.1).
 *
 * WHY THE DAEMON OWNS THIS, rather than `host enable` wiring it once:
 *
 *   · **The bind is the ownership proof.** Holding `127.0.0.1:P` is what
 *     entitles a process to receive the overlay's traffic, so the forward must
 *     not exist while the port is unowned. A forward pointing at a port nothing
 *     holds delivers member requests — bearer tokens and all — to whatever
 *     local process binds it next. The forward is therefore wired only AFTER a
 *     successful bind, and retired on graceful stop.
 *   · **Enable-time wiring cannot be made correct.** `host enable` is
 *     skip-if-done at every step, so wiring placed inside "install tailscaled"
 *     or "join" is skipped on exactly the re-run a recovery story would invoke.
 *   · **The forward is DURABLE.** It survives a tailscaled restart with no
 *     re-wiring (measured on the rig), which is what makes an orphan permanent
 *     rather than transient.
 *
 * This mirrors `ExternalMcpContainmentAuthority`'s posture for the other piece
 * of persistent, out-of-process exposure Myco creates.
 *
 * The unix-socket answer used for external-MCP Funnel is NOT available here:
 * `serve --tcp` rejects a unix target outright (`unable to expand target: unix
 * sockets are not supported for this target type`), and `--tcp` is mandatory
 * because headscale implements no cert endpoint, so HTTPS serve 501s. The
 * residual is therefore bounded by lifecycle discipline, never eliminated.
 */
import net from 'node:net';

import { LOG_KINDS } from '../constants/log-kinds.js';
import { OVERLAY_COMMAND_TIMEOUT_MS } from '../host/overlay-binaries.js';

import type { TailscaleCli } from '../host/tailscale-cli.js';

/** `tailscale serve status --json` — the only shape this module reads.
 *  An unconfigured node returns `{}` with NO `TCP` key at all, so every
 *  access below tolerates absence rather than assuming an empty object. */
interface ServeStatus {
  TCP?: Record<string, { TCPForward?: unknown } | undefined>;
}

/** The loopback target every Myco overlay forward must point at. */
function expectedForwardTarget(port: number): string {
  return `127.0.0.1:${port}`;
}

/**
 * THE invariant, stated precisely: a forward may exist only if something is
 * listening on the port it targets.
 *
 * Not "only while THIS daemon serves" — that framing is wrong and dangerous.
 * Host state lives in `~/.myco-team`, which is independent of `MYCO_HOME`, so
 * several daemons on one machine share one tailscaled. A daemon that is not
 * itself serving retiring every forward it can see would tear down a SIBLING's
 * live one — guaranteed on a box running a dogfood daemon beside prod.
 *
 * Keying on the port's liveness instead makes the rule locally checkable and
 * safe for any daemon to enforce: a port with a live listener is by definition
 * not the leak, and skipping it can never harm a healthy peer.
 *
 * BIND-PROBED, not process-listed. `findPidsListeningOn` shells out to
 * `lsof`/`ss`/PowerShell and returns `[]` when the tool is MISSING or ERRORS
 * (`myco-shared/src/port.ts`) — so "couldn't look" is indistinguishable from
 * "nothing there", and a probe failure would resolve to "not held", which is
 * the destructive direction. Reachable on a minimal container image with no
 * `lsof`, or when `lsof` exceeds its own timeout on a loaded box.
 *
 * A bind attempt has no such ambiguity, needs no external binary, and is the
 * same evidence the daemon uses to claim the port in the first place:
 * `EADDRINUSE` means held; a successful listen means free; anything else is
 * treated as held, and unlike the previous guard that branch can actually fire.
 */
export function isPortHeld(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const done = (held: boolean) => {
      if (settled) return;
      settled = true;
      try { probe.close(); } catch { /* never listened */ }
      resolve(held);
    };
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE => somebody holds it. Anything else (EACCES, EPERM, an
      // unexpected failure) => assume held, because retiring is destructive.
      done(true);
      void err;
    });
    probe.listen(port, '127.0.0.1', () => done(false));
  });
}

export interface OverlayForwardLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/** Ports currently carrying a `--tcp` forward on THIS tailscaled instance. */
export async function readServeTcpPorts(cli: TailscaleCli): Promise<number[]> {
  return (await readServeTcpForwards(cli)).map((f) => f.port);
}

/** Every `--tcp` forward on THIS instance, with its target — the target
 *  matters because a forward on the right PORT aimed somewhere else is not the
 *  forward we want, and treating it as converged would leave it in place. */
export async function readServeTcpForwards(
  cli: TailscaleCli,
): Promise<{ port: number; target: string | null }[]> {
  const res = await cli.run(['serve', 'status', '--json'], { timeoutMs: OVERLAY_COMMAND_TIMEOUT_MS });
  if (res.exitCode !== 0) {
    throw new Error(`\`tailscale serve status\` failed (exit ${res.exitCode}): ${res.stdout.trim()}`);
  }
  let parsed: ServeStatus;
  try {
    parsed = JSON.parse(res.stdout || '{}') as ServeStatus;
  } catch (err) {
    throw new Error(`could not parse \`tailscale serve status --json\`: ${(err as Error).message}`);
  }
  const tcp = parsed.TCP;
  if (!tcp || typeof tcp !== 'object') return [];
  return Object.entries(tcp)
    .map(([port, entry]) => ({
      port: Number(port),
      target: typeof entry?.TCPForward === 'string' ? entry.TCPForward : null,
    }))
    .filter((f) => Number.isInteger(f.port) && f.port >= 1 && f.port <= 65535);
}

/**
 * Remove the `--tcp` forward for `port`. Idempotent: tailscale exits NON-ZERO
 * with "serve config does not exist" when the port carries no forward, which is
 * the ordinary case on a clean shutdown — treating that as failure would make
 * every graceful stop report an error.
 */
/**
 * Retire every forward whose target port has NO live listener — the
 * "unheld port" convergence target. Safe to call from any daemon on any path,
 * including one that is not serving, because a port with a listener is left
 * alone. Returns the ports it retired. Never throws.
 */
export async function retireUnheldOverlayForwards(
  cli: TailscaleCli,
  logger?: OverlayForwardLogger,
): Promise<number[]> {
  const retired: number[] = [];
  try {
    for (const forward of await readServeTcpForwards(cli)) {
      if (await isPortHeld(forward.port)) continue;
      await retireOverlayForward(cli, forward.port);
      retired.push(forward.port);
      logger?.info(LOG_KINDS.HOST_SERVE, 'Retired an overlay forward whose port nothing holds', {
        port: forward.port,
      });
    }
  } catch (err) {
    logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Could not converge overlay forwards — one may still route member traffic to an unheld port',
      { error: (err as Error).message },
    );
  }
  return retired;
}

export async function retireOverlayForward(cli: TailscaleCli, port: number): Promise<void> {
  const res = await cli.run(['serve', `--tcp=${port}`, 'off'], { timeoutMs: OVERLAY_COMMAND_TIMEOUT_MS });
  if (res.exitCode === 0) return;
  if (/serve config does not exist/i.test(res.stdout)) return;
  throw new Error(`\`tailscale serve --tcp=${port} off\` failed (exit ${res.exitCode}): ${res.stdout.trim()}`);
}

/**
 * Converge THIS instance's serve config on exactly one forward: `port` →
 * `127.0.0.1:port`.
 *
 * RECONCILES rather than adds. `port` can legitimately change between runs — a
 * `host disable` nulls it and the next enable allocates afresh — and a
 * superseded forward left behind is durable and points at a port nothing
 * holds. Safe to remove every other forward because this is Myco's OWN private
 * tailscaled instance, reached through its private socket — a vendor install's
 * serve config lives on a different daemon entirely and is never visible here.
 */
export async function reconcileOverlayForward(
  cli: TailscaleCli,
  port: number,
  logger?: OverlayForwardLogger,
): Promise<void> {
  const existing = await readServeTcpForwards(cli);
  for (const stale of existing.filter((f) => f.port !== port)) {
    await retireOverlayForward(cli, stale.port);
    logger?.info(LOG_KINDS.HOST_SERVE, 'Retired a superseded overlay forward', { port: stale.port });
  }
  // Converged only when the port AND its target are right. A forward on the
  // correct port aimed elsewhere would otherwise be treated as done and left
  // in place, sending member traffic somewhere we never chose.
  const current = existing.find((f) => f.port === port);
  if (current && current.target === expectedForwardTarget(port)) return;
  if (current) {
    await retireOverlayForward(cli, port);
    logger?.info(LOG_KINDS.HOST_SERVE, 'Retired an overlay forward pointing at the wrong target', {
      port, target: current.target,
    });
  }
  const res = await cli.run(
    ['serve', '--bg', `--tcp=${port}`, `tcp://127.0.0.1:${port}`],
    { timeoutMs: OVERLAY_COMMAND_TIMEOUT_MS },
  );
  if (res.exitCode !== 0) {
    throw new Error(
      `\`tailscale serve --tcp=${port}\` failed (exit ${res.exitCode}): ${res.stdout.trim()}. `
      + 'The overlay listener is bound but unreachable from the tailnet until this succeeds.',
    );
  }
  logger?.info(LOG_KINDS.HOST_SERVE, 'Overlay forward wired', { port });
}
