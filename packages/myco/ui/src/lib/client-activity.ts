import { withBasePath } from './base-path';

/**
 * The dashboard's own interaction state, mirrored out of `PowerProvider` so
 * the plain fetch layer can read it without being a hook.
 *
 * Only `active` means a human is actually touching the page. The daemon treats
 * every other value as a client that is merely present — without that, a tab
 * left open on a desk would hold the machine awake indefinitely, because the
 * notifications heartbeat keeps polling even while the UI is in its own deep
 * sleep.
 *
 * Deliberately its own module rather than part of `lib/api`. Several UI tests
 * partially mock `lib/api`, so a new named export there fails to resolve for
 * every one of them — and this is client state, not API surface.
 */
let clientActivity = 'active';

export function setClientActivity(state: string): void {
  clientActivity = state;
}

export function readClientActivity(): string {
  return clientActivity;
}

/**
 * Fire-and-forget nudge telling the daemon a human is back at the keyboard.
 *
 * The daemon stops its tick timer entirely in deep sleep, so nothing on the
 * client can revive it by polling logic alone — a request has to arrive at the
 * door. `/version` is the cheapest endpoint that still passes through the
 * classification seam, and needs no tenancy or auth headers, so this carries
 * only the activity declaration.
 *
 * Errors are swallowed: it is best-effort, and a genuinely unreachable daemon
 * surfaces through the queries that actually matter.
 */
export function pingDaemonAwake(): Promise<void> {
  if (typeof fetch !== 'function') return Promise.resolve();
  return fetch(withBasePath('/api/version'), {
    headers: { 'x-myco-client-activity': clientActivity },
  }).then(() => undefined, () => undefined);
}
