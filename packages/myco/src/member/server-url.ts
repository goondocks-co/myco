/**
 * The one rule for which server URLs a member accepts: `https:` anywhere, or
 * plain `http:` on this machine's own loopback, where a self-hosted native
 * Deployment serves a laptop (`docs/self-hosting.md`). Plain http to any other
 * host is refused, since a member credential would cross the network in clear.
 *
 * Every place a member admits a server URL reads this predicate: `myco login`
 * and the join code, `myco member join`, registry resolution, the env source,
 * the MCP headers helper, and the installer's reading of a member's MCP entry.
 * `tests/meta/member-server-url-rule.test.ts` fails when a protocol check
 * appears in member code anywhere else.
 */

/** How a refusal names the rule to a person reading a terminal. */
export const MEMBER_SERVER_URL_RULE = "https, or http on this machine's loopback";

/** A host on this machine's own loopback: the IPv4 loopback block, the IPv6 loopback, or its name. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** True for a server URL a member accepts: `https:`, or `http:` on a loopback host. */
export function isMemberServerUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}
