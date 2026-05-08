/**
 * Bearer token auth for the Myco team sync worker.
 */

export interface AuthEnv {
  MYCO_TEAM_API_KEY: string;
}

/**
 * Validate the Authorization header against the configured team key.
 * Returns null on success, or a 401 Response on failure.
 *
 * Comparison is timing-safe: presented and configured tokens are first
 * SHA-256 digested (giving a fixed 32-byte length regardless of the
 * inputs), then compared with `crypto.subtle.timingSafeEqual`. This
 * avoids the timing oracle on Cloudflare Workers' shared infrastructure
 * that a naive `===` comparison would expose — even though the runtime's
 * V8 isolation makes the leak narrower than on traditional servers, the
 * fix is one digest call so we apply it as a defense-in-depth.
 */
export async function validateAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const header = request.headers.get('Authorization');
  if (!header) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !env.MYCO_TEAM_API_KEY) {
    return new Response(JSON.stringify({ error: 'Invalid Team key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ok = await timingSafeEqualString(token, env.MYCO_TEAM_API_KEY);
  if (!ok) {
    return new Response(JSON.stringify({ error: 'Invalid Team key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

/**
 * Timing-safe string equality. Hashes both inputs to fixed-length
 * SHA-256 digests so the comparison runs in constant time regardless of
 * the inputs' original byte lengths, then defers the byte-level compare
 * to `crypto.subtle.timingSafeEqual` (Workers runtime; standardized in
 * recent Web Crypto extensions). On runtimes without the helper we fall
 * back to a manual constant-time XOR over the equal-length digests.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const subtle = crypto.subtle as typeof crypto.subtle & {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(aDigest, bDigest);
  }
  return constantTimeBufferEqual(new Uint8Array(aDigest), new Uint8Array(bDigest));
}

function constantTimeBufferEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}
