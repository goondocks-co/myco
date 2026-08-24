import type { Database } from 'bun:sqlite';
import type { BlobStore, StoredObject } from '@myco-server-worker/core/adapters.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { sqliteD1, seededSqlite } from './d1.js';

/** The canonical form a bare `text/plain` upload is stored under. */
export const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';

/** A deterministic member-minted id in the UUID grammar; distinct for every `n`. */
export const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const PRODUCER = { adapter: 'claude-code', version: '2.0.0-test' };
export const PROTOCOL = { [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) };

/** A well-formed `prompt` envelope; every field can be overridden. */
export function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: uuid(1), sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, channel: 'cli', producer: PRODUCER,
    payload: { promptId: uuid(2), text: 'hi', origin: 'user' },
    ...over,
  };
}

/** The headers of an authenticated member request from source 1.2.3.4 at the current protocol. */
export function memberHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  // A credential is Deployment-wide, so every member request names the Project it
  // acts on. `extra` overrides it, which is how a test drives another Project; an
  // empty value drops the header, which is how a test sends none at all.
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', [PROJECT_HEADER]: 'proj_1', ...PROTOCOL, ...extra };
  return Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== ''));
}

/** A member POST of a JSON body to `/events` (or another path). */
export function memberPost(token: string, body: unknown, path = '/events', extra: Record<string, string> = {}): Request {
  return new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token, extra), body: typeof body === 'string' ? body : JSON.stringify(body) });
}

/** A member blob upload: bytes to `/blobs/{key}` with content-type and content-length. */
export function blobPost(token: string, key: string, bytes: Uint8Array, mediaType = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): Request {
  return new Request(`https://s/blobs/${key}`, {
    method: 'POST',
    headers: memberHeaders(token, { 'content-type': mediaType, 'content-length': String(bytes.byteLength), ...extra }),
    body: bytes,
  });
}

/** A limiter that records every key it is asked about and never refuses. */
export function recordingLimiter() {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } };
}

export interface MemoryBlobStore extends BlobStore {
  objects: Map<string, { size: number; contentType?: string }>;
  puts: string[];
  heads: string[];
  deletes: string[];
  /** When set, the next put throws an error with this message. */
  failNextPut: string | null;
}

/** An in-memory blob store: `put` reads the stream to its end, verifies the declared digest and length like R2, and records the object; `head` answers from memory; `delete` removes the object. */
export function memoryBlobStore(): MemoryBlobStore {
  const store: MemoryBlobStore = {
    objects: new Map(),
    puts: [],
    heads: [],
    deletes: [],
    failNextPut: null,
    async head(key) {
      store.heads.push(key);
      const o = store.objects.get(key);
      return o ? ({ size: o.size } satisfies StoredObject) : null;
    },
    async get(key) {
      const o = store.objects.get(key);
      if (!o) return null;
      return {
        size: o.size,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(o.size));
            controller.close();
          },
        }),
      };
    },
    async put(key, value, options) {
      store.puts.push(key);
      if (store.failNextPut) { const m = store.failNextPut; store.failNextPut = null; throw new Error(m); }
      const bytes = value ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(0);
      if (options?.sha256 && (await sha256HexOf(bytes)) !== options.sha256) {
        throw new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)');
      }
      store.objects.set(key, { size: bytes.byteLength, contentType: options?.httpMetadata?.contentType });
      return { size: bytes.byteLength };
    },
    async delete(key) {
      store.deletes.push(key);
      store.objects.delete(key);
    },
  };
  return store;
}

/** A SQLite-backed Env with the migrated schema, two projects, recording limiters, an in-memory blob store, and every statement it executes. */
export function sqliteEnv(opts: { staleBytesWritten?: number; onSql?: (sql: string, sqlite: Database) => void } = {}) {
  const sqlite: Database = seededSqlite();
  const executed: string[] = [];
  const db = sqliteD1(sqlite, {
    onFirst: (sql, row) =>
      row && opts.staleBytesWritten !== undefined && sql.includes('member_credentials') ? { ...row, bytes_written: opts.staleBytesWritten } : row,
    onSql: (sql) => { executed.push(sql); opts.onSql?.(sql, sqlite); },
  });
  const source = recordingLimiter();
  const token = recordingLimiter();
  const bucket = memoryBlobStore();
  // The Cloudflare BINDINGS shape: `worker.fetch` is the deployed Cloudflare entry
  // point and maps bindings itself. The store behind MYCO_DB is bun:sqlite, which makes
  // these tests a check of the shared core rather than of D1. The both-targets proof
  // lives in `tests/myco-server/contract/`.
  const e = { MYCO_DB: db, BUCKET: bucket, SOURCE_LIMIT: source, TOKEN_LIMIT: token } as any;
  // `env` is what the deployed Cloudflare entry receives; `serverEnv` is the same
  // deployment mapped into the vocabulary the core speaks, for tests that drive the
  // core handler directly rather than through an entry point. It re-maps on every
  // access, exactly as the entry point maps per request — so a test that swaps a
  // binding to inject a storage failure is reflected, as it would be in production.
  return {
    env: e,
    get serverEnv() { return serverEnvFromBindings(e); },
    db, sqlite, bucket, sourceKeys: source.keys, tokenKeys: token.keys, executed,
  };
}

export const count = (sqlite: Database, table: string): number => (sqlite.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
export const bytesWritten = (sqlite: Database, tokenId: string): number => (sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(tokenId) as { b: number }).b;
