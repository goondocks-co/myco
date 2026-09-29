/**
 * The one rule for which server URLs a member accepts: `https:` anywhere, or
 * plain `http:` on this machine's own loopback, where a self-hosted native
 * Deployment serves a laptop (`docs/self-hosting.md`). Plain http to any other
 * host is refused, since a member credential would cross the network in clear.
 *
 * Loopback http is acceptable only because it never leaves the machine, so
 * admitting it also keeps it off any configured proxy. Bun's `fetch` sends
 * `http://127.0.0.1:…` to `HTTP_PROXY` unless `NO_PROXY` names the host
 * exactly, and a proxy would carry the bearer in clear. `NO_PROXY` is the only
 * control it offers — there is no per-request bypass, and it matches exact
 * hosts and suffixes, never a CIDR block — so admission adds the admitted host
 * to it, and the CLI entry adds the loopback names at process start
 * (`cli/loopback-proxy.ts`) for the dials that read a URL admitted earlier,
 * such as a renewal from the registry.
 *
 * Every place a member admits a server URL calls `admitMemberServerUrl`:
 * `myco login` and the join code, `myco member join`, registry resolution, the
 * env source, the MCP headers helper, and the installer's reading of a member's
 * MCP entry. `tests/meta/member-server-url-rule.test.ts` fails on a URL-scheme
 * test in member-side code anywhere but here.
 */

/** How a refusal names the rule to a person reading a terminal. */
export const MEMBER_SERVER_URL_RULE = "https, or http on this machine's loopback";

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const;
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const;

/** A host on this machine's own loopback: the IPv4 loopback block, the IPv6 loopback, or its name. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Add `hosts` to `NO_PROXY` and `no_proxy`, when this process has a proxy
 * configured. A process with no proxy is left untouched.
 */
export function bypassProxyFor(hosts: readonly string[], env: NodeJS.ProcessEnv): void {
  if (!PROXY_VARS.some((name) => env[name]?.trim())) return;
  for (const name of NO_PROXY_VARS) {
    const held = (env[name] ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
    const missing = hosts.filter((h) => !held.includes(h));
    if (missing.length > 0 || env[name] === undefined) env[name] = [...held, ...missing].join(',');
  }
}

/**
 * True for a server URL a member accepts: `https:`, or `http:` on a loopback
 * host. A loopback host it admits is added to this process's proxy bypass, so
 * the dial that follows goes straight to it.
 */
export function admitMemberServerUrl(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return false;
  bypassProxyFor([url.hostname], env);
  return true;
}
