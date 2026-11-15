
/** HTTP session material is confined to loopback and private IP addresses. */
export function completionEndpointRefusal(url: URL): string | null {
  if (url.protocol === 'https:') return null;
  if (url.protocol !== 'http:') return 'expected an HTTP or HTTPS base URL';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(host)) return null;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168))) return null;
  return 'session text requires HTTPS for a public address; HTTP is allowed only for loopback or private IP addresses';
}
