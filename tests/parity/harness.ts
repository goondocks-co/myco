import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';

/**
 * One booted server target. A scenario receives this and nothing else, so a
 * scenario that passes against both targets has proven the behavior on both.
 *
 * `sql` reads and writes the target's own store (bun:sqlite on the self-hosted
 * volume, `wrangler d1 execute --local` on the Worker's local D1) — seeding and
 * assertion go through the same store the server serves from.
 */
export interface ParityTarget {
  name: 'selfhosted' | 'cloudflare';
  url: string;
  memberToken: string;
  projectId: string;
  /**
   * Headers an owner request carries: the signed session cookie — and on the
   * Cloudflare target the `cf-connecting-ip` header, which wrangler dev never
   * injects on its own; without a source identity the pipeline answers 503 to
   * every non-public route. The Bun target reads the socket and ignores it.
   */
  ownerHeaders(): Record<string, string>;
  memberHeaders(extra?: Record<string, string>): Record<string, string>;
  sql(command: string): Promise<Record<string, unknown>[]>;
  stop(): Promise<void>;
}

export interface ParityScenario {
  name: string;
  run(target: ParityTarget): Promise<void>;
}

export const MEMBER_ID = 'mem_parity';
export const MACHINE_ID = 'machine_parity';
export const PROJECT_ID = 'proj_parity';
export const GITHUB_SUB = '424242';
export const SESSION_SECRET = 'parity-session-secret-0123456789abcdef';

/** The member request headers both targets accept; the source header is load-bearing only on Cloudflare. */
export function memberHeadersFor(token: string, projectId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    [PROJECT_HEADER]: projectId,
    [PROTOCOL_HEADER]: String(SERVER_PROTOCOL),
    'cf-connecting-ip': '1.2.3.4',
    ...extra,
  };
}

/** A write's answer as the server persisted it. Ingest answers a refusal as a 200 with `persisted: false`, so the status alone proves nothing; a scenario's writes go through this. */
export async function expectPersisted(res: Response, label: string): Promise<void> {
  const body = (await res.json()) as { persisted?: boolean; stored?: boolean; code?: string; reason?: string };
  const landed = body.persisted === true || body.stored === true;
  expect(`${label}: ${res.status} ${landed ? 'persisted' : `refused ${body.code ?? ''} ${body.reason ?? ''}`.trim()}`).toBe(`${label}: 200 persisted`);
}

/** A single-quoted SQL literal; scenario values MUST pass through this on their way into `target.sql`. */
export const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Polls `read` until `pred` answers true or `ms` elapses; answers the last read either way. */
export async function waitFor<T>(read: () => Promise<T>, pred: (value: T) => boolean, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!pred(last) && Date.now() < deadline) {
    await Bun.sleep(300);
    last = await read();
  }
  return last;
}

/** Opens a read/write connection on a self-hosted volume; WAL keeps it safe beside the serving process. */
export function volumeSql(databasePath: string) {
  return async (command: string): Promise<Record<string, unknown>[]> => {
    const sqlite = new Database(databasePath);
    sqlite.exec('PRAGMA busy_timeout = 5000');
    try {
      return sqlite.query(command).all() as Record<string, unknown>[];
    } finally {
      sqlite.close();
    }
  };
}
