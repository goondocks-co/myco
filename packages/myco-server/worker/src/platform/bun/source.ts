/**
 * Source identity for a self-hosted deployment.
 *
 * A deployment reached directly takes the address from the socket, which no caller
 * can forge. A deployment behind a reverse proxy takes it from a header the
 * operator declares — and a forwarded header is a LIST, which the common proxy
 * configurations append to rather than replace, so its left-most entry is whatever
 * the client sent. Reading from the left lets a caller choose its own rate-limit
 * bucket and defeat every pre-authentication limit. The address is therefore taken
 * from the RIGHT, stepping back exactly as many entries as the operator says its
 * own proxies add.
 *
 * A deployment that declares neither establishes no identity, which the core
 * answers 503 to rather than admitting unmetered traffic. In both forms the value
 * is canonicalised as an address, so a caller cannot hand arbitrary text into a
 * bucket key.
 *
 * The full trusted-proxy contract — which headers, how operators declare topology,
 * how many hops a given deployment has — is #909's research decision. This is the
 * minimum that lets the self-hosted entry point run without inventing it early.
 *
 * The same proxy terminates TLS. The owner surface sets a `__Host-` prefixed
 * session cookie, which browsers accept only over HTTPS, so a deployment served
 * over plain HTTP can carry capture but cannot sign an owner in.
 */
import type { SourceIdentity } from '../../core/adapters.js';
import { canonicalAddress } from '../../core/address.js';

/** A server able to report the socket address a request arrived on. */
export interface AddressableServer {
  requestIP(request: Request): { address: string } | null;
}

/**
 * Source identity taken from the socket the request arrived on. It yields nothing
 * until the listening server is bound, which keeps an unbound handler fail-closed.
 */
export function socketSourceOf(server: () => AddressableServer | null): SourceIdentity {
  return (request) => {
    const bound = server();
    if (bound === null) return null;
    const address = bound.requestIP(request)?.address;
    return address === undefined ? null : canonicalAddress(address);
  };
}

export interface TrustedProxyConfig {
  /** The header the operator has declared trustworthy. Absent ⇒ no identity is established. */
  header?: string;
  /** How many trailing entries of that header this deployment's own proxies contribute. Defaults to one. */
  trustedHops?: number;
}

/** The longest forwarded list worth parsing; a longer one is a caller trying to make the server do work. */
const MAX_FORWARDED_ENTRIES = 32;

export function trustedProxySourceOf({ header, trustedHops = 1 }: TrustedProxyConfig): SourceIdentity {
  return (request) => {
    if (header === undefined || header === '' || trustedHops < 1) return null;
    const value = request.headers.get(header);
    if (value === null || value === '') return null;
    const entries = value.split(',');
    if (entries.length > MAX_FORWARDED_ENTRIES) return null;
    // The right-most entry is this deployment's own proxy; step back past the hops
    // it declares to reach the address that proxy observed.
    const candidate = entries[entries.length - trustedHops];
    return candidate === undefined ? null : canonicalAddress(candidate.trim());
  };
}
