/**
 * The C-local transport contract, enforced at startup.
 *
 * Loopback HTTP is permitted for a member reaching a same-machine container,
 * gated on a verified property of the socket, never on a configuration flag.
 * Four conditions hold together or the deployment does not start. Each one
 * alone turns "loopback only" into "reachable from the network".
 *
 * 1. A loopback LITERAL, never the name. The name resolves through host
 *    configuration this process cannot verify. Secure Contexts §3.1 separates
 *    the literals from the name; #835 records a `::1` hijack.
 * 2. BOTH loopback families bound, or refuse to start. One family bound leaves
 *    the other free for another process to claim, and a client resolving that
 *    family reaches the other process.
 * 3. A Host-header allowlist. A loopback socket answers requests carrying any
 *    Host, which a hostile page uses to steer a browser on the machine (DNS
 *    rebinding). The socket carries no evidence of it; the header does.
 * 4. Loopback-qualified publishing. `PORT:PORT` in Compose publishes on every
 *    interface with no signal inside the container, so condition 4 is verified
 *    against the shipped Compose file, not here.
 *
 * **Where conditions 1 and 2 apply.** They constrain the HOST-VISIBLE bind. A
 * process on the host binds the loopback literals itself. A container does not:
 * its network namespace has its own loopback, and Docker publishes a host
 * address to the container's `eth0` (172.17.0.2 in the default bridge), so a
 * process bound to 127.0.0.1 inside the namespace is unreachable through
 * published ports. Measured, not assumed: such a container answers `/health`
 * 200 from `docker exec` and refuses the connection from the host.
 *
 * For a container the namespace is the boundary and condition 4 is the
 * host-visible bind, so conditions 1 and 2 are satisfied by the publish spec
 * rather than by the process. `MYCO_BIND=all` selects that shape and is safe
 * ONLY alongside loopback-qualified publishing; the two ship in the same
 * Compose file and `compose-publish.test.ts` gates the pairing. Condition 3
 * holds in both shapes — a socket cannot see a forged Host either way.
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
