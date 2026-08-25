import type { SecretWrappingKey } from '../core/adapters.js';

/**
 * Building a `SecretWrappingKey` from whatever a target holds it in.
 *
 * Both targets end here, and both end with the same refusal: a deployment with no
 * key configured throws by name on first use. The alternative — falling back to
 * storing a credential unsealed — would undo the one property the design exists
 * for, silently, on the deployment least likely to notice.
 */

/** Bytes of key material AES-256 requires. */
export const WRAPPING_KEY_BYTES = 32;

/** The key version a deployment uses until one is rotated. */
const INITIAL_KEY_VERSION = 1;

export class WrappingKeyUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(`secret wrapping key unavailable: ${detail}`);
    this.name = 'WrappingKeyUnavailableError';
  }
}

/**
 * A key from base64url or base64 text — the shape both targets carry it in.
 *
 * The length is checked rather than trusted. `importKey` accepts some truncated
 * inputs, which would seal real credentials under material far weaker than
 * intended, and nothing downstream would report it.
 */
export function wrappingKeyFromText(read: () => Promise<string | undefined>, source: string, version = INITIAL_KEY_VERSION): SecretWrappingKey {
  let material: Promise<ArrayBuffer> | null = null;
  return {
    material() {
      material ??= (async () => {
        const text = await read();
        if (text === undefined || text.length === 0) throw new WrappingKeyUnavailableError(`${source} is not set`);
        const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
        } catch {
          throw new WrappingKeyUnavailableError(`${source} is not base64`);
        }
        if (bytes.byteLength !== WRAPPING_KEY_BYTES) {
          throw new WrappingKeyUnavailableError(`${source} must decode to ${WRAPPING_KEY_BYTES} bytes, got ${bytes.byteLength}`);
        }
        return bytes.buffer as ArrayBuffer;
      })();
      return material;
    },
    version: async () => version,
  };
}
