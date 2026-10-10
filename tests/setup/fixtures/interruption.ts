import type { OutboundFetch } from '@myco-server-worker/core/adapters.js';

export const SETUP_INTERRUPTION_POINTS = [
  'after-create-before-sign-in', 'after-github-conversion-before-install',
  'expired-owner-link', 'timed-out-approval', 'enrollment-done-install-failed',
  'cutover-between-projects', 'cutover-between-destinations', 'terminal-403-mid-import',
] as const;
export type SetupInterruptionPoint = typeof SETUP_INTERRUPTION_POINTS[number];

export class SetupInterrupted extends Error {
  constructor(readonly point: SetupInterruptionPoint) { super(`setup fixture interrupted: ${point}`); }
}

/** A one-shot interruption; a resumed operation can pass the same checkpoint. */
export function interruptOnce(point: SetupInterruptionPoint) {
  let armed = true;
  const visited: SetupInterruptionPoint[] = [];
  return {
    visited,
    checkpoint(at: SetupInterruptionPoint): void {
      visited.push(at);
      if (armed && at === point) { armed = false; throw new SetupInterrupted(point); }
    },
  };
}

/** A terminal import refusal after the declared number of accepted requests; never calls a network itself. */
export function refuseImportAfter(accepted: number, delegate: OutboundFetch) {
  if (!Number.isSafeInteger(accepted) || accepted < 1) throw new Error('mid-import fixture requires an accepted request');
  const requests: ReturnType<Request['clone']>[] = [];
  const fetchImpl: OutboundFetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return requests.length > accepted
      ? Response.json({ error: 'forbidden' }, { status: 403 })
      : delegate(request);
  };
  return { requests, fetchImpl };
}
