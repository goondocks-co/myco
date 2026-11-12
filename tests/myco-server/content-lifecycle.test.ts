import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { prepareDerivedContent, type DerivedContentSource } from '@myco-server-worker/core/registered-content.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';

const NOW = Date.now();
const source = (over: Partial<DerivedContentSource> = {}): DerivedContentSource => ({ projectId: 'proj_1', sessionId: 's', eventId: 'e', tokenId: 'server', envelopeHash: 'h', sourceKind: 'document', resourceId: 'r', ...over });
const rows = (e: ReturnType<typeof sqliteEnv>, sql: string) => e.sqlite.query(sql).all();
const ownership = (e: ReturnType<typeof sqliteEnv>) => ({
  reservations: rows(e, 'SELECT reservation_id FROM blob_reservations'), intents: rows(e, 'SELECT physical FROM object_settlement_intents'),
  journal: rows(e, 'SELECT physical FROM object_releases'), blobs: rows(e, 'SELECT key FROM blobs'),
});
const preparing = (e: ReturnType<typeof sqliteEnv>, text = 'body') => prepareDerivedContent({ db: e.db, blobs: e.bucket }, source(), text, NOW);

describe('a server-derived body has one owner at every step', () => {
  it('registers with a durable proof and leaves no authority or intent behind', async () => {
    const e = sqliteEnv();
    const content = await preparing(e);
    const owned = ownership(e);
    expect(owned.reservations).toEqual([]);
    expect(owned.intents).toEqual([]);
    expect(owned.journal).toEqual([]);
    expect(owned.blobs).toEqual([{ key: content.key }]);
    expect(e.sqlite.query('SELECT generation,durable FROM registered_content_proofs').all()).toEqual([{ generation: content.generation, durable: 1 }]);
    e.sqlite.close();
  });

  it('arms the orphan audit when a derived body is admitted', async () => {
    const e = sqliteEnv();
    try {
      await preparing(e);
      expect(e.sqlite.query('SELECT armed_at FROM orphan_sweep_state WHERE id=1').get()).toEqual({ armed_at: NOW });
    } finally { e.sqlite.close(); }
  });

  it('a second body of the same content registers one object and adds its proof', async () => {
    const e = sqliteEnv();
    const first = await preparing(e);
    const second = await prepareDerivedContent({ db: e.db, blobs: e.bucket }, source({ eventId: 'e2', resourceId: 'r2', envelopeHash: 'h2' }), 'body', NOW);
    expect(second.generation).toBe(first.generation);
    expect(e.sqlite.query('SELECT COUNT(*) AS n FROM registered_content_proofs').get()).toEqual({ n: 2 });
    expect(e.bucket.objects.size).toBe(1);
    e.sqlite.close();
  });

  it('a store write that never answered leaves the unresolved object an intent the drain revisits', async () => {
    const e = sqliteEnv();
    e.bucket.failNextPut = 'PUT answer lost';
    await expect(preparing(e)).rejects.toThrow('PUT answer lost');
    const owned = ownership(e);
    expect(owned.reservations).toEqual([]);
    expect(owned.intents).toHaveLength(1);
    expect(owned.journal).toHaveLength(1);
    e.sqlite.close();
  });

  it('bytes that failed verification are journaled and their intent resolved', async () => {
    const e = sqliteEnv();
    const put = e.bucket.put.bind(e.bucket);
    e.bucket.put = async (key, value, options) => { await put(key, value, options); return { size: 1, durable: true }; };
    await expect(preparing(e)).rejects.toThrow('content_archive_size_mismatch');
    const owned = ownership(e);
    expect(owned.reservations).toEqual([]);
    expect(owned.intents).toEqual([]);
    expect(owned.journal).toHaveLength(1);
    e.sqlite.close();
  });

  it('a failed settlement leaves the authority standing, and the drain settles the upload after its expiry', async () => {
    const e = sqliteEnv();
    const db: RelationalStore = e.db;
    let fail = false;
    const failing: RelationalStore = { ...db, prepare: sql => db.prepare(sql), batch: async statements => {
      if (fail) throw new Error('store unavailable');
      return db.batch(statements);
    } };
    const blobs = memoryBlobStore();
    blobs.put = async () => { fail = true; throw new Error('PUT rejected'); };
    await expect(prepareDerivedContent({ db: failing, blobs }, source(), 'body', NOW)).rejects.toThrow();
    fail = false;
    const left = ownership(e);
    expect(left.reservations).toHaveLength(1);
    expect(left.intents).toHaveLength(1);
    await drainObjectReleases({ db, blobs }, NOW + BLOB_RESERVATION_TTL_MS + 1);
    expect(ownership(e).reservations).toEqual([]);
    e.sqlite.close();
  });
});
