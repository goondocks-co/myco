/**
 * Base64 for byte arrays, built in bounded chunks.
 *
 * The obvious form — `btoa(String.fromCharCode(...bytes))` — passes one argument
 * per byte, and the two runtimes disagree about how many arguments a call may
 * take: JSC accepts a 320KB spread and V8 throws `RangeError: Maximum call stack
 * size exceeded` at roughly 125k. Any code sealing or encoding a caller-sized
 * value that way behaves differently on the two deployment targets, and no test
 * running on one engine can see it.
 *
 * Every encoder in this server routes through here so the shape exists in one
 * place, and a gate refuses an unbounded spread anywhere under `src`.
 */

/** Bytes per `String.fromCharCode` call. Well under either runtime's argument limit. */
const CHUNK = 0x8000;

/** Standard base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** Unpadded base64url of `bytes` — the shape every credential this server mints is presented in. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Bytes of a base64 or base64url string, in a view Web Crypto accepts on both
 * targets.
 *
 * `Uint8Array.from` is typed over `ArrayBufferLike`, which admits
 * `SharedArrayBuffer` and so is not a `BufferSource` under the stricter of the two
 * runtimes' lib definitions; copying into a plainly-owned buffer keeps one
 * implementation compiling against both.
 */
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
