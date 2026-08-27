const encoder = new TextEncoder();

/**
 * UTF-8 bytes in a buffer this module owns.
 *
 * `TextEncoder.encode` is typed over `ArrayBufferLike`, which admits a
 * `SharedArrayBuffer` and is therefore not a `BufferSource` the Web Crypto
 * signatures accept. Copying into an `ArrayBuffer` this function allocates
 * makes the narrower type true by construction rather than asserted — the
 * inputs here are cookie bodies and short strings, so the copy is not a cost
 * worth a cast.
 */
export function utf8(input: string): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(input);
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length));
  bytes.set(encoded);
  return bytes;
}

export async function sha256HexOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): Promise<string> {
  return sha256HexOf(utf8(input));
}
