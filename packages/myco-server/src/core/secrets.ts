import { commit, type Bound } from '../db/index.js';
import { listSecrets, readRunnerSecret, readSecret, type SecretRow } from '../db/settings/secret-rows.js';
import type { RunnerSecretAvailability, RunnerSecretVersion } from '../db/settings/runner-secret-health.js';
import type { StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import { putSecret, removeRetiredSecrets, removeSecret, recordSecretDeletion } from '../db/settings/secret-writes.js';
import { HARNESS_CREDENTIALS, credentialEnvFor, credentialKind, type HarnessCredentialKind } from '@goondocks/myco-shared/harness-providers';
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
  /** Whether the stored value is a subscription token or an API key; null when nothing readable is stored. Never the value. */
  kind: HarnessCredentialKind | null;
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
type SecretValueCheck = { ok: true; value: string } | { ok: false; reason: string };

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

/** A stored credential cannot be opened under the Deployment's current wrapping key. */
export class SecretOpenError extends Error {
  constructor() { super('stored credential is unreadable'); this.name = 'SecretOpenError'; }
}

export interface SecretStore {
  /** Seal `value` under the deployment's wrapping key and record who stored it, as `normalizeSecretValue` shapes it; throws `SecretValueError` for a value it refuses. */
  put(name: string, value: string, actor: string, nowMs: number): Promise<void>;
  /**
   * The plaintext, or null when nothing is stored.
   *
   * The store opens plaintext through this method and `runnerKey` for callers
   * that need to authenticate.
   */
  get(name: string): Promise<string | null>;
  /** Open a runner key with the sealed generation and its current provider observation. */
  runnerKey(name: string, now: number): Promise<{
    key: string; version: RunnerSecretVersion; failure: StoredKeyFailure | null; probeDue: boolean;
  } | null>;
  /** What a settings surface may show. Never returns the value. */
  describe(name: string): Promise<SecretDescription>;
  /** Every stored secret's description, including the private slots recovery has to carry. */
  list(): Promise<Array<SecretDescription & { name: string }>>;
  /** `deleted` is false when no row existed under `name`. */
  delete(name: string, actor: string, nowMs: number): Promise<{ deleted: boolean }>;
  /** Removes rows under names no slot admits any more, in one bounded statement; answers the names removed. */
  removeRetired(actor: string, nowMs: number): Promise<string[]>;
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
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(row.iv), additionalData: encoder.encode(row.name) },
      key,
      fromBase64(row.ciphertext),
    );
  } catch { throw new SecretOpenError(); }
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

  const openRow = async (r: SecretRow): Promise<string> => {
    let importedKey: CryptoKey;
    try { importedKey = await key(); }
    catch { throw new SecretOpenError(); }
    return open(importedKey, r);
  };

  const row = (name: string): Promise<SecretRow | null> => readSecret(db, name);
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
    let kind: HarnessCredentialKind | null = null;
    let readable = true;
    try {
      // The mask is derived here rather than stored. A stored preview would put the
      // first and last characters of every credential back into the table this
      // design exists to keep them out of.
      const value = await openRow(r);
      maskedValue = maskSecret(value);
      kind = credentialKind(value);
    } catch {
      readable = false;
    }
    return { name: r.name, configured: true, readable, maskedValue, kind, updatedAt: r.updated_at, updatedBy: r.updated_by };
  };

  const preparePut = async (name: string, raw: string, actor: string, nowMs: number): Promise<Bound<never, 'write'>> => {
    const checked = normalizeSecretValue(raw);
    if (!checked.ok) throw new SecretValueError(checked.reason);
    const { ciphertext, iv } = await seal(await key(), name, checked.value);
    return putSecret.bind(name, ciphertext, iv, await wrappingKey.version(), nowMs, actor);
  };
  return {
    async put(name, raw, actor, nowMs) {
      await commit(db, await preparePut(name, raw, actor, nowMs));
    },

    async get(name) {
      const r = await row(name);
      return r === null ? null : openRow(r);
    },

    async runnerKey(name, now) {
      const r = await readRunnerSecret(db, name, now);
      if (r === null) return null;
      try {
        return { key: await openRow(r), version: { slot: name, generation: r.iv }, failure: r.failure, probeDue: r.probeDue === 1 };
      } catch (error) {
        if (error instanceof SecretOpenError || error instanceof SecretValueError) return null;
        throw error;
      }
    },

    async describe(name) {
      const r = await row(name);
      if (r === null) return { configured: false, readable: true, maskedValue: null, kind: null, updatedAt: null, updatedBy: null };
      const { name: _name, ...rest } = await described(r);
      return rest;
    },

    async list() {
      return Promise.all((await listSecrets(db)).map(described));
    },

    async delete(name, actor, nowMs) {
      const [result] = await commit(db, removeSecret.bind(name));
      const deleted = result.results.length === 1;
      // Every other mutation on this table records its actor on the row. Deletion
      // removes the row, making it the one destructive operation here whose trail
      // lives nowhere but this event.
      recordSecretDeletion(name, actor, nowMs, deleted);
      return { deleted };
    },

    async removeRetired(actor, nowMs) {
      const [result] = await commit(db, removeRetiredSecrets.bind());
      const names = result.results.map(row => row.name);
      for (const name of names) recordSecretDeletion(name, actor, nowMs, true);
      return names;
    },
  };
}

/** One request opens each stored slot at most once and receives only agent usability. */
export function harnessCredentialAvailability(db: RelationalStore, wrappingKey: SecretWrappingKey): (harness: string) => Promise<RunnerSecretAvailability> {
  const store = deploymentSecretStore(db, wrappingKey);
  const slots = new Map<string, ReturnType<SecretStore['runnerKey']>>();
  return async harness => {
    const slot = HARNESS_CREDENTIALS[harness]?.slot;
    if (slot == null) return false;
    let opened = slots.get(slot);
    if (opened === undefined) {
      opened = store.runnerKey(slot, 0);
      slots.set(slot, opened);
    }
    const key = await opened;
    if (key === null || Object.keys(credentialEnvFor(harness, key.key)).length === 0) return false;
    return key.failure ?? true;
  };
}

/** A stored choice can name a locally usable key while its provider is refusing it. */
export async function harnessCredentialAvailable(db: RelationalStore, wrappingKey: SecretWrappingKey, harness: string): Promise<boolean> {
  return await harnessCredentialAvailability(db, wrappingKey)(harness) !== false;
}

