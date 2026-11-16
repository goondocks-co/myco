/** What an operator can safely do with this Deployment's recovery surfaces. */
export function rewindAvailability(target: 'bun' | 'cloudflare'): string {
  return target === 'bun'
    ? 'This self-hosted Deployment has no Time Travel. Recover from a verified backup with myco server restore --target local.'
    : 'Safe rewind is unavailable: writers and external indexes cannot yet be paused and reset together. Recover from a verified backup with myco server restore --target cloudflare.';
}
