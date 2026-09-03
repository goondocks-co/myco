import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import { emit } from '../telemetry.js';
import { fromBase64, toBase64 } from '../base64.js';

/**
 * Deployment-held secrets: sealed at rest, opened only where a value is actually
 * needed.
 *
 * The store holds ciphertext and the wrapping key does not live in it. That is
 * the property the whole design exists for — `BREAK-GLASS.md` prescribes direct
 * store access as the recovery path and #907 settled infrastructure control as
 * proof of authority, so someone querying the store is an expected, routine
 * event rather than a breach. Plaintext there would turn every such query into a
 * disclosure of every provider credential at once.
 *
 * One implementation serves both targets. The only per-target difference is
 * where `SecretWrappingKey` gets its material.
 */

/** Bytes of IV per seal. 96 bits is the AES-GCM nominal, which keeps the tag construction on the standard path. */
const IV_BYTES = 12;

/** Leading and trailing plaintext characters a mask reveals, matching the shipped member surface. */
const MASK_PREFIX = 8;
const MASK_SUFFIX = 4;

/**
 * The shortest secret a mask may be shown for.
 *
 * Three times what a mask reveals, so a preview never exposes more than a third of
 * a value. Set at `revealed + 4` instead, a 16-character secret would show 12 of
 * its characters — the mask would be the secret.
 */
const MASKABLE_MIN = (MASK_PREFIX + MASK_SUFFIX) * 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a caller may know about a secret without holding it. */
export interface SecretDescription {
  configured: boolean;
  /** False when a stored row will not open under the current wrapping key. A configured-but-unreadable slot is what an operator must re-enter. */
  readable: boolean;
  /** First and last characters only, or null when nothing is stored. Never the value. */
  maskedValue: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/**
 * A pasted credential as it may be stored, or why it may not.
 *
 * Horizontal whitespace is stripped EVERYWHERE, not just at the ends: no
 * credential this store holds (API keys, subscription tokens, PATs)
 * legitimately contains a space, and a token copied from a soft-wrapped
 * terminal arrives with spaces at the wrap columns. Stored as pasted, every
 * harness run then fails to authenticate while Settings shows the slot
 * configured — seen on the 1.4 machine store (#774) and again on the first
 * Deployment (#1045 S4 smoke, 2026-09-02). Repairing at this boundary, the
 * one write path for Deployment secrets, makes that paste shape impossible to
 * store broken.
 *
 * Line-structure and control characters are refused, never repaired: an
 * input shaped like an injection gets an error, not a silent rewrite.
 */
export type SecretValueCheck = { ok: true; value: string } | { ok: false; reason: string };

export function normalizeSecretValue(raw: string): SecretValueCheck {
  const value = raw.replace(/[ \t]+/g, '');
  if (value.length === 0) return { ok: false, reason: 'value is empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'value carries a line break or control character' };
  return { ok: true, value };
}

/** A value the store refuses to seal, with text safe to show to the person who pasted it. */
export class SecretValueError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SecretValueError';
  }
}

export interface SecretStore {
  /** Seal `value` under the deployment's wrapping key and record who stored it, as `normalizeSecretValue` shapes it; throws `SecretValueError` for a value it refuses. */
  put(name: string, value: string, actor: string, nowMs: number): Promise<void>;
  /**
   * The plaintext, or null when nothing is stored.
   *
   * This is the only function that returns a credential. Its callers are the
   * ones that must actually authenticate something — never a display surface —
   * and a gate holds it to them.
   */
  get(name: string): Promise<string | null>;
  /** What a settings surface may show. Never returns the value. */
  describe(name: string): Promise<SecretDescription>;
  /** Every stored secret's description, for the settings surface. */
  list(): Promise<Array<SecretDescription & { name: string }>>;
  /** `deleted` is false when no row existed under `name`. */
  delete(name: string, actor: string, nowMs: number): Promise<{ deleted: boolean }>;
}

/**
 * The mask a settings surface shows.
 *
 * A secret too short to mask is reported as configured with no preview rather
 * than mostly revealed: masking a four-character value would display it almost
 * whole.
 */
export function maskSecret(value: string): string | null {
  if (value.length < MASKABLE_MIN) return null;
  return `${value.slice(0, MASK_PREFIX)}…${value.slice(-MASK_SUFFIX)}`;
}

interface SecretRow {
  name: string;
  ciphertext: string;
  iv: string;
  key_version: number;
  updated_at: number;
  updated_by: string;
}

/**
 * Seals `value` for the slot named `name`.
 *
 * The slot name is the additional authenticated data, which binds a ciphertext
 * to the row it belongs in: moving the `anthropic` ciphertext into the `github`
 * row makes it fail to open rather than quietly authenticate the wrong service
 * with the wrong credential.
 */
async function seal(key: CryptoKey, name: string, value: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(name) },
    key,
    encoder.encode(value),
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

/**
 * Opens a row's ciphertext for its own slot, shaped as `normalizeSecretValue`
 * shapes a paste. A row that fails to open, or that opens to a value the store
 * would refuse today, throws rather than returning a wrong value: a row sealed
 * before the store normalized on write still serves its credential clean, and
 * nothing ever has to be pasted twice for the store to catch up.
 */
async function open(key: CryptoKey, row: SecretRow): Promise<string> {
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(row.iv), additionalData: encoder.encode(row.name) },
    key,
    fromBase64(row.ciphertext),
  );
  const checked = normalizeSecretValue(decoder.decode(opened));
  if (!checked.ok) throw new SecretValueError(checked.reason);
  return checked.value;
}

/** The store, over a relational store and the deployment's wrapping key. */
export function deploymentSecretStore(db: RelationalStore, wrappingKey: SecretWrappingKey): SecretStore {
  // The imported key is cached for the lifetime of this store rather than per call:
  // an entry point may build a ServerEnv per request, in which case this is a
  // request-scoped cache and nothing outlives the request.
  let imported: Promise<CryptoKey> | null = null;
  const key = (): Promise<CryptoKey> => {
    imported ??= wrappingKey.material().then((material) =>
      crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    return imported;
  };

  const row = (name: string): Promise<SecretRow | null> => db
    .prepare(`SELECT name, ciphertext, iv, key_version, updated_at, updated_by FROM deployment_secrets WHERE name = ?`)
    .bind(name)
    .first<SecretRow>();

  /**
   * A row as a surface may see it.
   *
   * A row that will not open is reported UNREADABLE rather than thrown, and the
   * distinction matters operationally. Under a rotated wrapping key, a corrupted
   * `iv` or a partly restored backup, one bad slot failing the whole response takes
   * down the very page that tells an operator which credentials to re-enter.
   */
  const described = async (r: SecretRow): Promise<SecretDescription & { name: string }> => {
    let maskedValue: string | null = null;
    let readable = true;
    try {
      // The mask is derived here rather than stored. A stored preview would put the
      // first and last characters of every credential back into the table this
      // design exists to keep them out of.
      maskedValue = maskSecret(await open(await key(), r));
    } catch {
      readable = false;
    }
    return { name: r.name, configured: true, readable, maskedValue, updatedAt: r.updated_at, updatedBy: r.updated_by };
  };

  return {
    async put(name, raw, actor, nowMs) {
      const checked = normalizeSecretValue(raw);
      if (!checked.ok) throw new SecretValueError(checked.reason);
      const { ciphertext, iv } = await seal(await key(), name, checked.value);
      await db
        .prepare(`INSERT INTO deployment_secrets (name, ciphertext, iv, key_version, updated_at, updated_by)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(name) DO UPDATE SET
                    ciphertext = excluded.ciphertext, iv = excluded.iv,
                    key_version = excluded.key_version, updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by`)
        .bind(name, ciphertext, iv, await wrappingKey.version(), nowMs, actor)
        .run();
    },

    async get(name) {
      const r = await row(name);
      return r === null ? null : open(await key(), r);
    },

    async describe(name) {
      const r = await row(name);
      if (r === null) return { configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null };
      const { name: _name, ...rest } = await described(r);
      return rest;
    },

    async list() {
      const { results } = await db
        .prepare(`SELECT name, ciphertext, iv, key_version, updated_at, updated_by FROM deployment_secrets ORDER BY name`)
        .all<SecretRow>();
      return Promise.all(results.map(described));
    },

    async delete(name, actor, nowMs) {
      const result = await db.prepare(`DELETE FROM deployment_secrets WHERE name = ?`).bind(name).run();
      const deleted = result.meta.changes === 1;
      // Every other mutation on this table records its actor on the row. Deletion
      // removes the row, making it the one destructive operation here whose trail
      // lives nowhere but this event.
      emit({ kind: 'deployment_secret_deleted', name, actor, deleted, at: nowMs });
      return { deleted };
    },
  };
}
