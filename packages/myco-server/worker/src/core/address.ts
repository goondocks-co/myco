/**
 * Canonical form of a client network address.
 *
 * An address is not a platform concept: every deployment target has to reduce a
 * client address to a stable rate-limit key the same way, and a key space that
 * differs per target is a metering difference between targets. Text that is not an
 * address yields no identity, so an adapter can never hand an arbitrary caller
 * string into a bucket key.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The four octets of a dotted quad, or null when the text is not one. */
function ipv4Octets(text: string): number[] | null {
  const m = IPV4.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.some((o) => o > 255) ? null : octets;
}

/** The two hex groups of an embedded IPv4 tail, or null when the text is not a dotted quad. */
function embeddedIpv4Groups(text: string): string[] | null {
  const octets = ipv4Octets(text);
  if (octets === null) return null;
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

/**
 * The canonical form of `address` — IPv4 as a dotted quad without leading zeros,
 * IPv4-mapped IPv6 as that quad, IPv6 collapsed to its canonical /64 — or null
 * when the text is not an address.
 */
export function canonicalAddress(address: string): string | null {
  if (address === '') return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  const quad = mapped ? mapped[1] : address.includes(':') ? null : address;
  if (quad !== null) {
    const octets = ipv4Octets(quad);
    return octets === null ? null : octets.join('.');
  }
  const groups = ipv6Groups(address);
  if (groups === null) return null;
  return `${groups.slice(0, 4).join(':')}::/64`;
}
