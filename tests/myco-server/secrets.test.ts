/**
 * Deployment-held secrets (#961, #915 L1).
 *
 * The property the whole design exists for: the store holds ciphertext, and the
 * key that opens it does not live there. Direct store access is a designed,
 * routine capability — `BREAK-GLASS.md` prescribes it — so a credential readable
 * from the store alone would make every recovery operation a disclosure.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { deploymentSecretStore, maskSecret } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText, WRAPPING_KEY_BYTES, WrappingKeyUnavailableError } from '@myco-server-worker/platform/wrapping-key.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(WRAPPING_KEY_BYTES))));
const OTHER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(WRAPPING_KEY_BYTES))));

const ANTHROPIC = 'sk-ant-api03-ZmFrZS1rZXktZm9yLXRlc3Rpbmc';

function rig(keyText: string = KEY) {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  const db = sqliteRelationalStore(sqlite);
  return { sqlite, db, store: deploymentSecretStore(db, wrappingKeyFromText(async () => keyText, 'TEST_KEY')) };
}

const raw = (sqlite: Database) => JSON.stringify(sqlite.query(`SELECT * FROM deployment_secrets`).all());

describe('deployment secrets', () => {
  it('round-trips a value, and the stored row does not contain it', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);

    expect(await r.store.get('anthropic')).toBe(ANTHROPIC);
    // The property, asserted against the bytes an operator would actually see.
    expect(raw(r.sqlite)).not.toContain(ANTHROPIC);
    expect(raw(r.sqlite)).not.toContain(ANTHROPIC.slice(0, 16));
  });

  it('cannot be opened by a different wrapping key, so the store alone is not enough', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);

    // Same rows, different key — this is an operator holding a database dump.
    const impostor = deploymentSecretStore(r.db, wrappingKeyFromText(async () => OTHER_KEY, 'TEST_KEY'));
    await expect(impostor.get('anthropic')).rejects.toThrow();
  });

  it('binds a ciphertext to its own slot: one moved to another name fails to open rather than returning the wrong credential', async () => {
    // The failure this prevents is silent and severe — the Deployment would
    // authenticate to one service using another service's credential.
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    await r.store.put('github', 'ghp_someothercredential_value', 'mem_1', 1_000);

    const anthropic = r.sqlite.query(`SELECT ciphertext, iv FROM deployment_secrets WHERE name='anthropic'`).get() as { ciphertext: string; iv: string };
    r.sqlite.query(`UPDATE deployment_secrets SET ciphertext = ?, iv = ? WHERE name = 'github'`).run(anthropic.ciphertext, anthropic.iv);

    await expect(r.store.get('github')).rejects.toThrow();
  });

  it('describes without ever returning the value, and derives the mask rather than storing one', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_7', 2_000);

    const described = await r.store.describe('anthropic');
    expect(described).toEqual({
      configured: true,
      readable: true,
      maskedValue: `${ANTHROPIC.slice(0, 8)}…${ANTHROPIC.slice(-4)}`,
      updatedAt: 2_000,
      updatedBy: 'mem_7',
    });
    expect(JSON.stringify(described)).not.toContain(ANTHROPIC);
    // A stored preview would put the first and last characters of every credential
    // back into the table this design exists to keep them out of.
    expect(raw(r.sqlite)).not.toContain(ANTHROPIC.slice(0, 8));
  });

  it('reports an absent secret as unconfigured rather than failing', async () => {
    const r = rig();
    expect(await r.store.describe('never-set')).toEqual({ configured: false, readable: true, maskedValue: null, updatedAt: null, updatedBy: null });
    expect(await r.store.get('never-set')).toBeNull();
  });

  it('masks nothing for a value too short to mask, rather than showing most of it', () => {
    expect(maskSecret('short')).toBeNull();
    // 16 characters would show 12 of them — the mask would be the secret. The floor
    // is three times what a preview reveals, so a mask never exposes over a third.
    expect(maskSecret('0123456789abcdef')).toBeNull();
    expect(maskSecret('0123456789abcdefghijklmnopqrstuvwxyz')).toBe('01234567…wxyz');
  });

  it('replaces a value in place, with a fresh IV, and records who did it', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    const first = r.sqlite.query(`SELECT ciphertext, iv FROM deployment_secrets WHERE name='anthropic'`).get() as { ciphertext: string; iv: string };

    await r.store.put('anthropic', `${ANTHROPIC}-rotated`, 'mem_2', 5_000);
    const second = r.sqlite.query(`SELECT ciphertext, iv, updated_by, updated_at FROM deployment_secrets WHERE name='anthropic'`).get() as Record<string, unknown>;

    expect(await r.store.get('anthropic')).toBe(`${ANTHROPIC}-rotated`);
    expect(second.iv).not.toBe(first.iv);
    expect({ by: second.updated_by, at: second.updated_at }).toEqual({ by: 'mem_2', at: 5_000 });
    expect((r.sqlite.query(`SELECT COUNT(*) c FROM deployment_secrets`).get() as { c: number }).c).toBe(1);
  });

  it('never seals the same value to the same bytes twice', async () => {
    const r = rig();
    await r.store.put('a', ANTHROPIC, 'mem_1', 1_000);
    const a = r.sqlite.query(`SELECT ciphertext FROM deployment_secrets WHERE name='a'`).get() as { ciphertext: string };
    await r.store.put('b', ANTHROPIC, 'mem_1', 1_000);
    const b = r.sqlite.query(`SELECT ciphertext FROM deployment_secrets WHERE name='b'`).get() as { ciphertext: string };
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('records which key sealed each row, so a later re-wrap can find them', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    expect((r.sqlite.query(`SELECT key_version FROM deployment_secrets WHERE name='anthropic'`).get() as { key_version: number }).key_version).toBe(1);
  });

  it('reports a row it cannot open as configured-but-unreadable, and keeps describing the rest', async () => {
    // Under a rotated key, a corrupted iv, or a partly restored backup, one bad slot
    // must not fail the response — the page that tells an operator what to re-enter
    // is the page they need most at that moment.
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    await r.store.put('github', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa', 'mem_1', 1_000);
    r.sqlite.query(`UPDATE deployment_secrets SET iv = ? WHERE name = 'anthropic'`).run(btoa('123456789012'));

    expect(await r.store.describe('anthropic')).toMatchObject({ configured: true, readable: false, maskedValue: null });
    expect(await r.store.describe('github')).toMatchObject({ configured: true, readable: true });
    const listed = await r.store.list();
    expect(listed.map((s) => [s.name, s.readable])).toEqual([['anthropic', false], ['github', true]]);
  });

  it('deletes, and reports whether anything was there', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    expect(await r.store.delete('anthropic', 'mem_1', 2_000)).toEqual({ deleted: true });
    expect(await r.store.describe('anthropic')).toMatchObject({ configured: false });
    expect(await r.store.delete('anthropic', 'mem_1', 3_000)).toEqual({ deleted: false });
  });

  it('lists every secret as a description, never as values', async () => {
    const r = rig();
    await r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000);
    await r.store.put('github', 'ghp_aaaaaaaaaaaaaaaaaaaa', 'mem_2', 2_000);
    const listed = await r.store.list();
    expect(listed.map((s) => s.name)).toEqual(['anthropic', 'github']);
    expect(JSON.stringify(listed)).not.toContain(ANTHROPIC);
  });
});

describe('the wrapping key', () => {
  it('refuses a deployment that has none, by name, rather than storing anything in the clear', async () => {
    const r = rig();
    const unkeyed = deploymentSecretStore(r.db, wrappingKeyFromText(async () => undefined, 'MYCO_SECRET_WRAP_KEY'));
    await expect(unkeyed.put('anthropic', ANTHROPIC, 'mem_1', 1_000)).rejects.toThrow(WrappingKeyUnavailableError);
    // And nothing landed: a refusal that half-wrote would be worse than either outcome.
    expect((r.sqlite.query(`SELECT COUNT(*) c FROM deployment_secrets`).get() as { c: number }).c).toBe(0);
  });

  it('refuses a key of the wrong length rather than sealing under weaker material than intended', async () => {
    const short = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const r = rig(short);
    await expect(r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000)).rejects.toThrow(/32 bytes, got 16/);
  });

  it('refuses material that is not base64 rather than failing later inside the cipher', async () => {
    const r = rig('not-valid-base64!!!');
    await expect(r.store.put('anthropic', ANTHROPIC, 'mem_1', 1_000)).rejects.toThrow(/not base64/);
  });
});
