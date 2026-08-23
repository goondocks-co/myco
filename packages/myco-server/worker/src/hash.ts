const encoder = new TextEncoder();

/**
 * The two deployment targets' lib definitions model `crypto.subtle` differently:
 * one types an encoder's output as backed by `ArrayBufferLike`, the other accepts
 * only `ArrayBuffer`. Nothing in this server ever produces a `SharedArrayBuffer`,
 * so the narrowing is sound. It exists solely so the shared core compiles against
 * both targets.
 */
export const asBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>;

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): Promise<string> {
  return sha256HexOf(utf8(input));
}
