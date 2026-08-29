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

/** The namespace every derived member id lives under; the member side holds the same value as `MEMBER_ID_NAMESPACE`. */
export const DERIVED_ID_NAMESPACE = '6f0b1f8e-2c3a-4d5e-9a7b-8c1d2e3f4a5b';

const NAMESPACE_BYTES = Uint8Array.from(DERIVED_ID_NAMESPACE.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));

/**
 * UUIDv5 over the derived-id namespace of the NUL-joined parts — byte for byte
 * what the member derives for a plan key (`packages/myco/src/member/envelope.ts`
 * `deriveId`), so a plan the server names and a plan a member names land on the
 * same row. SHA-1 is the algorithm the UUIDv5 form fixes; it is a name, not a
 * credential.
 */
export async function uuidv5(...parts: string[]): Promise<string> {
  const name = utf8(parts.join('\0'));
  const input = new Uint8Array(new ArrayBuffer(NAMESPACE_BYTES.length + name.length));
  input.set(NAMESPACE_BYTES);
  input.set(name, NAMESPACE_BYTES.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
