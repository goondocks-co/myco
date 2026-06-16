/**
 * Drive a daemon's graceful drain over HTTP from the service layer.
 *
 * `schtasks /end` (the Windows stop/restart primitive) is an uncatchable
 * TerminateProcess that skips the daemon's graceful shutdown — orphaning
 * in-flight agent runs and the team-sync outbox until the next boot. POSTing
 * `/api/shutdown` first lets the daemon drain and exit on its own; the `/end`
 * that follows is then a no-op cleanup (or the hard fallback if the drain
 * wedged). POSIX managers (`launchctl kickstart -k` / `systemctl restart`)
 * deliver a catchable SIGTERM that already drains, so they never call this.
 */
import { DAEMON_HEALTH_CHECK_TIMEOUT_MS, RECONCILE_COOPERATIVE_GRACE_MS } from '../constants.js';

export interface CooperativeShutdownDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Total budget for accept + drain + exit. Defaults to the reconcile grace. */
  graceMs?: number;
  /** Poll interval while waiting for the daemon to stop answering. */
  pollMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST `/api/shutdown` (accepted ONLY on the daemon's 202 ack) and poll
 * `/health` until the port stops answering. Returns true when the daemon
 * accepted AND exited within the budget; false otherwise (the caller then
 * falls back to a hard `schtasks /end`). Never throws.
 */
export async function requestCooperativeShutdown(
  port: number,
  deps: CooperativeShutdownDeps = {},
): Promise<boolean> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const graceMs = deps.graceMs ?? RECONCILE_COOPERATIVE_GRACE_MS;
  const pollMs = deps.pollMs ?? 100;

  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
    });
    // A non-202 (foreign loopback service, or a daemon too old for the route)
    // is not a real cooperative-shutdown ack — fall back to the hard kill.
    if (res.status !== 202) return false;
  } catch {
    return false;
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try {
      const health = await fetchFn(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!health.ok) return true;
    } catch {
      // Connection refused / aborted → the daemon has exited.
      return true;
    }
  }
  return false;
}
