const encoder = new TextEncoder();

export function utf8(input: string): Uint8Array {
  return encoder.encode(input);
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(input: string): Promise<string> {
  return sha256HexOf(utf8(input));
}
