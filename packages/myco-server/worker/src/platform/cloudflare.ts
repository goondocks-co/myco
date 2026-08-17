import type { D1Like, RateLimiter } from '../env.js';

// Compile-time proof that the platform bindings satisfy the adapter interfaces.
type AssertAssignable<A, B extends A> = B;
export type _D1Satisfies = AssertAssignable<D1Like, D1Database>;
export type _RateLimitSatisfies = AssertAssignable<RateLimiter, RateLimit>;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The two hex groups of an embedded IPv4 tail, or null when the text is not a dotted quad. */
function embeddedIpv4Groups(text: string): string[] | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
}

/** Expands an IPv6 address to its eight canonical groups (lowercase hex, no leading zeros); returns null when the text is not an IPv6 address. */
function ipv6Groups(address: string): string[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const last = tail.length > 0 ? tail : head;
  if (last.length > 0 && last[last.length - 1].includes('.')) {
    const v4 = embeddedIpv4Groups(last[last.length - 1]);
    if (v4 === null) return null;
    last.splice(last.length - 1, 1, ...v4);
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16).toString(16));
}

/** Source identity on Cloudflare: the edge-set client address, IPv6 collapsed to its canonical /64. */
export function cloudflareSourceOf(request: Request): string | null {
  const address = request.headers.get('cf-connecting-ip');
  if (address === null || address === '') return null;
  if (!address.includes(':')) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  return `${groups.slice(0, 4).join(':')}::/64`;
}
