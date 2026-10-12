/**
 * Loopback HTTP admission for native serving and explicitly isolated container ports.
 * Container operators must publish on loopback and declare socket-derived source addresses.
 * Native serving binds loopback literals directly.
 */

/** Loopback literals, the only admissible bind targets. */
export const LOOPBACK_V4 = '127.0.0.1';
export const LOOPBACK_V6 = '::1';

/** Host values a loopback deployment answers. Ports are compared separately. */
const ALLOWED_HOSTNAMES = new Set([LOOPBACK_V4, `[${LOOPBACK_V6}]`]);

export class LoopbackContractError extends Error {
  constructor(readonly condition: string, message: string) {
    super(message);
    this.name = 'LoopbackContractError';
  }
}

/**
 * Condition 1. Admits the two literals only. The name and every routable
 * address are rejected, as is the remainder of 127.0.0.0/8: a wider range
 * widens what a typo reaches.
 */
export function assertLoopbackLiteral(host: string): void {
  if (host === 'localhost') {
    throw new LoopbackContractError(
      'loopback-literal',
      "bind host 'localhost' is a name, not a literal: it resolves through host "
      + `configuration this process cannot verify. Use ${LOOPBACK_V4} or ${LOOPBACK_V6}.`,
    );
  }
  if (host !== LOOPBACK_V4 && host !== LOOPBACK_V6) {
    throw new LoopbackContractError(
      'loopback-literal',
      `bind host '${host}' is not a loopback literal; a loopback deployment binds `
      + `${LOOPBACK_V4} and ${LOOPBACK_V6} only.`,
    );
  }
}

/**
 * Condition 2. Both families, or nothing. The caller passes the families it
 * actually bound, and a missing one is named in the refusal. The check reads
 * bind results, never configuration.
 */
export function assertBothLoopbackFamiliesBound(bound: readonly string[]): void {
  const missing = [LOOPBACK_V4, LOOPBACK_V6].filter((family) => !bound.includes(family));
  if (missing.length > 0) {
    throw new LoopbackContractError(
      'both-families-bound',
      `loopback family ${missing.join(' and ')} is not bound. One family bound leaves the `
      + 'other free for another process to claim, and a client resolving that family reaches '
      + 'the other process. Refusing to start rather than serving half the loopback surface.',
    );
  }
}

/**
 * Condition 3. A request whose Host is not an allowlisted loopback authority is
 * refused, closing the DNS-rebinding path from a page on this machine.
 */
export function isAllowedLoopbackHost(header: string | null, port: number): boolean {
  if (header === null) return false;
  // `[::1]:8787` and `[::1]` bracket the address; `127.0.0.1:8787` and
  // `127.0.0.1` do not. A bare unbracketed `::1` is not a legal Host authority
  // and falls through to the refusal.
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header);
  if (match === null) return false;

  const [, hostname, declaredPort] = match;
  if (!ALLOWED_HOSTNAMES.has(hostname!)) return false;
  return declaredPort === undefined || declaredPort === String(port);
}
