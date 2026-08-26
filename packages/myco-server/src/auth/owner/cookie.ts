import { toBase64Url } from '../../base64.js';
import { asBufferSource } from '../../hash.js';

/** The owner's session cookie. The `__Host-` prefix makes `Secure`, `Path=/` and the absence of `Domain` browser-enforced rather than merely intended. */
export const SESSION_COOKIE = '__Host-myco_session';

/** A session's fixed life. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `sub` is the owner's numeric GitHub account id as text — never the login. */
export interface OwnerSession {
  sub: string;
  iat: number;
  exp: number;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

const b64url = toBase64Url;

const unb64url = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `<toBase64Url(payload)>.<toBase64Url(hmac)>` over any JSON payload carrying an `exp`. */
export async function signPayload<T extends { exp: number }>(secret: string, typ: string, payload: T): Promise<string> {
  const body = b64url(ENCODER.encode(JSON.stringify({ ...payload, typ })));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), ENCODER.encode(body)));
  return `${body}.${b64url(signature)}`;
}

/** The payload a well-signed, unexpired value carries, or null. Every malformed shape answers null rather than throwing. */
export async function verifyPayload<T extends { exp: number }>(secret: string, typ: string, value: string, now: number): Promise<T | null> {
  const split = value.indexOf('.');
  if (split <= 0 || split === value.length - 1) return null;
  const body = value.slice(0, split);
  let signature: Uint8Array;
  let payload: unknown;
  try {
    signature = unb64url(value.slice(split + 1));
  } catch {
    return null;
  }
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), asBufferSource(signature), asBufferSource(ENCODER.encode(body))))) return null;
  try {
    payload = JSON.parse(DECODER.decode(unb64url(body)));
  } catch {
    return null;
  }
  const parsed = payload as T & { typ?: unknown };
  // One key signs both the session cookie and the OAuth state, and the state travels in a
  // URL the caller sees. The type travels inside the signature, so neither can be presented
  // as the other however their shapes evolve.
  if (parsed?.typ !== typ) return null;
  return typeof parsed?.exp === 'number' && parsed.exp > now ? parsed : null;
}

/** `<toBase64Url(payload)>.<toBase64Url(hmac)>`. */
export const SESSION_TYP = 'session';

export async function signSession(secret: string, session: OwnerSession): Promise<string> {
  return signPayload(secret, SESSION_TYP, session);
}

/** The session carried by a well-signed, unexpired value, or null. */
export async function verifySession(secret: string, value: string, now: number): Promise<OwnerSession | null> {
  const session = await verifyPayload<OwnerSession>(secret, SESSION_TYP, value, now);
  if (session === null) return null;
  return typeof session.sub === 'string' && typeof session.iat === 'number' ? session : null;
}

export function setCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The session cookie's value out of a `Cookie` header, or null. */
export function readCookie(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) return trimmed.slice(SESSION_COOKIE.length + 1);
  }
  return null;
}
