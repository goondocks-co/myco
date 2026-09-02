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

export interface TitlingStub {
  url: string;
  requests: Array<{ path: string; model: string; material: string }>;
  up: boolean;
  stop(): void;
}

/**
 * A deterministic openai-compatible completions endpoint on the loopback. The
 * titling call for `agent.provider.type = 'openai-compatible'` goes verbatim to
 * `<base_url>/chat/completions` with no credential, and both targets must reach
 * the same loopback port — which is why the Cloudflare parity config strips
 * `global_fetch_strictly_public`.
 */
export function titlingStub(): TitlingStub {
  const stub: TitlingStub = { url: '', requests: [], up: true, stop: () => server.stop(true) };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (!path.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
      const body = await req.json() as { model: string; messages: Array<{ content: string }> };
      const material = body.messages[0]?.content ?? '';
      // Recorded whether up or down: an assertion about call COUNTS must see the
      // attempt a downed stub refuses, or a late duplicate hides behind the 503.
      stub.requests.push({ path, model: body.model, material });
      if (!stub.up) return new Response('down', { status: 503 });
      const title = material.includes('retry') ? 'Retry added to the runner' : 'Another session';
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title, summary: 'Added a retry to runner.ts and covered it with a test.' }) } }] });
    },
  });
  stub.url = `http://127.0.0.1:${server.port}`;
  return stub;
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
