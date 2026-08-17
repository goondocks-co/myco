import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES } from '../../packages/myco-server/worker/src/routes.js';
import worker from '../../packages/myco-server/worker/src/index.js';
import { createIngestThrottle } from './helpers/throttle.js';
import { sqliteD1, seededSqlite } from './helpers/d1.js';
import { issueMemberToken } from '../../packages/myco-server/worker/src/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, RETRY_AFTER_SECONDS, SERVER_SCHEMA_VERSION } from '../../packages/myco-server/worker/src/constants.js';
import { renderSchemaSql } from '../../packages/myco-server/worker/src/db/migrate.js';
import { SCHEMA_DDL } from '../../packages/myco-server/worker/src/db/schema.js';
import { cloudflareSourceOf } from '../../packages/myco-server/worker/src/platform/cloudflare.js';
import { sha256Hex } from '../../packages/myco-server/worker/src/hash.js';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const WORKER = fileURLToPath(new URL('../../packages/myco-server/worker/', import.meta.url));
const SRC = join(WORKER, 'src');
const TESTS = fileURLToPath(new URL('./', import.meta.url));
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
const files = (dir: string): string[] => allFiles(dir).filter((f) => f.endsWith('.ts'));
const sharedFiles = () => files(SRC).filter((f) => !f.includes(`${join(SRC, 'platform')}/`));

const K = SyntaxKind as unknown as Record<string, number>;
const EXPRESSION_END = new Set<number>([
  K.Identifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
  K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.PlusPlusToken, K.MinusMinusToken, K.RegularExpressionLiteral,
  K.ThisKeyword, K.NullKeyword, K.TrueKeyword, K.FalseKeyword, K.SuperKeyword,
]);

/** Every comment span in a TypeScript source, collected by the TypeScript scanner (regex literals and template substitutions re-scanned). */
function commentText(source: string): string {
  const scanner = createScanner(false, undefined, source);
  const out: string[] = [];
  let last: number | null = null;
  let depth = 0;
  const templates: number[] = [];
  for (let kind = scanner.scan(); kind !== K.EndOfFile; kind = scanner.scan()) {
    if ((kind === K.SlashToken || kind === K.SlashEqualsToken) && (last === null || !EXPRESSION_END.has(last))) kind = scanner.reScanSlashToken();
    if (kind === K.OpenBraceToken) depth += 1;
    else if (kind === K.CloseBraceToken) {
      if (templates.length > 0 && templates[templates.length - 1] === depth) { templates.pop(); kind = scanner.reScanTemplateToken(false); }
      else depth -= 1;
    }
    if (kind === K.TemplateHead || kind === K.TemplateMiddle) templates.push(depth);
    if (kind === K.SingleLineCommentTrivia || kind === K.MultiLineCommentTrivia) out.push(scanner.getTokenText());
    if (kind !== K.WhitespaceTrivia && kind !== K.NewLineTrivia && kind !== K.SingleLineCommentTrivia && kind !== K.MultiLineCommentTrivia) last = kind;
  }
  return out.join('\n');
}

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const normalize = (source: string) => stripComments(source).replace(/\s+/g, ' ').trim();

const CANONICAL_ENTRY = `
import type { Env } from './env.js';
import { createServer } from './pipeline.js';
import { cloudflareSourceOf } from './platform/cloudflare.js';
const server = createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf });
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  return server.handleRequest(request, env);
}
export default { fetch: handleRequest };
`;

const env = () => ({
  MYCO_DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
  SOURCE_LIMIT: createIngestThrottle(10_000, 60_000, 100, () => 0),
  TOKEN_LIMIT: createIngestThrottle(10_000, 60_000, 100, () => 0),
}) as any;
const PROBE_WORDS = ['leak', 'admin', 'backdoor', 'debug', 'metrics', 'internal', 'api', 'config', 'events', 'stop', 'sessions', 'register', 'mcp', 'status', 'export'];
const PROBE_PATHS: string[] = ['/', '/leak', '/admin', '/backdoor', '/events/stop', '/api/config', '/health/', '//health', '/HEALTH'];
for (let i = 0; i < 64; i++) {
  const a = PROBE_WORDS[(i * 7) % PROBE_WORDS.length];
  const b = PROBE_WORDS[(i * 11 + 3) % PROBE_WORDS.length];
  PROBE_PATHS.push(i % 3 === 0 ? `/${a}` : i % 3 === 1 ? `/${a}/${b}` : `/${a}/${b}/${i}`);
}
const withSource = (path: string, init: RequestInit = {}) =>
  new Request(`https://s${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'cf-connecting-ip': '1.2.3.4' } });

/** A limiter that records every key it is asked about and never refuses. */
function recordingLimiter() {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } };
}

/** A real SQLite-backed Env with the rendered schema, two projects, a transactional batch, and recording limiters. `staleBytesWritten` makes the auth row read report that value instead of the stored one. */
function sqliteEnv(opts: { staleBytesWritten?: number } = {}) {
  const sqlite = seededSqlite();
  const db = sqliteD1(sqlite, {
    onFirst: (sql, row) =>
      row && opts.staleBytesWritten !== undefined && sql.includes('member_tokens') ? { ...row, bytes_written: opts.staleBytesWritten } : row,
  });
  const source = recordingLimiter();
  const token = recordingLimiter();
  const e = { MYCO_DB: db, SOURCE_LIMIT: source, TOKEN_LIMIT: token } as any;
  return { env: e, db, sqlite, sourceKeys: source.keys, tokenKeys: token.keys };
}

const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 5, transport: 'cli', payload: { t: 'hi' }, ...over });
const memberPost = (token: string, body: string) =>
  withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });

describe('gates', () => {
  it('keeps the public set to exactly /health', () => {
    expect(ROUTES.filter((r) => r.auth === 'public').map((r) => `${r.method} ${r.path}`)).toEqual(['GET /health']);
  });

  it('refuses probed paths absent from the route table, via the deployed entry', async () => {
    for (const path of PROBE_PATHS) {
      for (const method of ['GET', 'POST']) {
        const res = await worker.fetch(withSource(path, { method, body: method === 'POST' ? '{}' : undefined }), env());
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
      }
    }
  });

  it('refuses every declared non-public route without a credential, via the deployed entry', async () => {
    for (const r of ROUTES.filter((x) => x.auth !== 'public')) {
      const res = await worker.fetch(withSource(r.path, { method: r.method, body: r.method === 'GET' ? undefined : '{}' }), env());
      expect(res.status).toBe(401);
    }
  });

  it('keeps the entry point identical to the canonical wiring shape', () => {
    expect(normalize(readFileSync(join(SRC, 'index.ts'), 'utf8'))).toBe(normalize(CANONICAL_ENTRY));
  });

  it('takes tenancy and attribution from the authenticated token only, via the deployed entry', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const t2 = await issueMemberToken(db, { projectId: 'proj_2', machineId: 'machine_2' }, Date.now());
    const post = (token: string, spoof: Record<string, unknown>) =>
      new Request(`https://s/events?projectId=proj_1&tokenId=${t1.tokenId}&machineId=machine_1`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', 'x-myco-project': 'proj_1', 'x-myco-machine': 'machine_1', 'x-myco-token': t1.tokenId },
        body: JSON.stringify({ eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 5, transport: 'cli', payload: { t: 'hi' }, ...spoof }),
      });
    const spoof = { projectId: 'proj_1', tokenId: t1.tokenId, machineId: 'machine_1' };
    expect(await (await worker.fetch(post(t1.token, {}), e)).json()).toEqual({ persisted: true });
    expect(await (await worker.fetch(post(t2.token, spoof), e)).json()).toEqual({ persisted: true });
    const sessions = sqlite.query(`SELECT project_id, machine_id, created_by_token_id FROM sessions ORDER BY project_id`).all();
    expect(sessions).toEqual([
      { project_id: 'proj_1', machine_id: 'machine_1', created_by_token_id: t1.tokenId },
      { project_id: 'proj_2', machine_id: 'machine_2', created_by_token_id: t2.tokenId },
    ]);
    const events = sqlite.query(`SELECT project_id, token_id FROM events ORDER BY project_id`).all();
    expect(events).toEqual([{ project_id: 'proj_1', token_id: t1.tokenId }, { project_id: 'proj_2', token_id: t2.tokenId }]);
  });

  it('keys the token limiter on the issued token id and never on credential material', async () => {
    const { env: e, db, tokenKeys } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const digest = await sha256Hex(t1.token);
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}` }, body: '{}' }), e);
      expect(res.status).toBe(200);
    }
    expect(tokenKeys).toEqual([t1.tokenId, t1.tokenId, t1.tokenId]);
    for (const key of tokenKeys) expect(key.includes(t1.token) || key.includes(digest) || t1.token.includes(key)).toBe(false);
  });

  it('keys the source limiter on the adapter identity only, whatever proxy headers the caller sends', async () => {
    const { env: e, sourceKeys, tokenKeys } = sqliteEnv();
    const spoofed: Record<string, string> = {
      'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9', 'true-client-ip': '8.8.8.8', 'x-client-ip': '7.7.7.7',
      forwarded: 'for=6.6.6.6', 'x-real-ip': '5.5.5.5', 'x-cluster-client-ip': '4.4.4.4',
    };
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(new Request('https://s/events', { method: 'POST', headers: spoofed, body: '{}' }), e);
      expect(res.status).toBe(401);
    }
    expect(sourceKeys).toEqual(['1.2.3.4', '1.2.3.4', '1.2.3.4']);
    expect(tokenKeys).toEqual([]);
  });

  it('bounds bytes_written by the schema even when the auth row read is stale', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ staleBytesWritten: 0 });
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE member_tokens SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA - 100, t1.tokenId);
    const body = JSON.stringify({ eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 5, transport: 'cli', payload: { t: 'x'.repeat(200) } });
    const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}` }, body }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, reason: 'token write quota exceeded' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b).toBe(MEMBER_TOKEN_BYTE_QUOTA - 100);
  });

  it('charges the quota only for a stored event: replays and same-project replays leave bytes_written unchanged', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_3' }, Date.now());
    const body = envelope();
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true });
    const charged = (sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b;
    expect(charged).toBe(new TextEncoder().encode(body).byteLength);
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true, duplicate: true });
    expect(await (await worker.fetch(memberPost(t3.token, body), e)).json()).toEqual({ persisted: true, duplicate: true });
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b).toBe(charged);
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t3.tokenId) as any).b).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(1);
  });

  it('refuses a reused event id whose payload differs, keeping the stored event', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    expect(await (await worker.fetch(memberPost(t1.token, envelope()), e)).json()).toEqual({ persisted: true });
    const res = await worker.fetch(memberPost(t1.token, envelope({ payload: { t: 'other' } })), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, reason: 'event id conflict' });
    expect((sqlite.query(`SELECT payload FROM events`).get() as any).payload).toBe(JSON.stringify({ t: 'hi' }));
  });

  it('refuses every member request with 503 when the database schema version is not this build\'s', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(SERVER_SCHEMA_VERSION + 1));
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    sqlite.query(`DELETE FROM schema_meta`).run();
    expect((await worker.fetch(memberPost(t1.token, envelope()), e)).status).toBe(503);
  });

  it('answers a post-auth storage failure with 503 and retry-after, never 200', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`DROP TABLE events`).run();
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(RETRY_AFTER_SECONDS));
    expect(await res.json()).toEqual({ persisted: false, reason: 'unavailable' });
  });

  it('advertises the rate-limit window it is configured with', () => {
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    const periods = [...toml.matchAll(/period = (\d+)/g)].map((m) => Number(m[1]));
    expect(periods).toEqual([RETRY_AFTER_SECONDS, RETRY_AFTER_SECONDS]);
  });

  it('never cancels or releases a request stream on the request path', () => {
    for (const f of ['ingest/body.ts', 'pipeline.ts', 'ingest/events.ts']) {
      const t = readFileSync(join(SRC, f), 'utf8');
      expect({ file: f, cancels: /\.cancel\(/.test(t), releases: /releaseLock\(/.test(t) }).toEqual({ file: f, cancels: false, releases: false });
    }
  });

  it('keeps every file under src a TypeScript source', () => {
    for (const f of allFiles(SRC)) expect({ file: f, ok: /\.ts$/.test(f) && !/\.d\.ts$/.test(f) }).toEqual({ file: f, ok: true });
  });

  it('collapses IPv6 sources to a /64 and keeps IPv4 sources distinct', () => {
    const src = (ip: string) => cloudflareSourceOf(new Request('https://s/', { headers: { 'cf-connecting-ip': ip } }));
    expect(src('2001:db8:1:2:aaaa::1')).toBe(src('2001:db8:1:2:bbbb:1:2:3'));
    expect(src('2001:db8:1:2::1')).not.toBe(src('2001:db8:1:3::1'));
    expect(src('1.2.3.4')).not.toBe(src('1.2.3.5'));
    expect(src('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(src('2001:0db8:0001:0002::1')).toBe(src('2001:db8:1:2::1'));
    expect(src('2001:DB8:1:2::1')).toBe(src('2001:db8:1:2::1'));
    expect(src('2001:db8:1:2::1.2.3.4')).toBe(src('2001:db8:1:2::1'));
    expect(src('2001:db8:1:2::999.1.1.1')).toBeNull();
    expect(src('')).toBeNull();
    expect(cloudflareSourceOf(new Request('https://s/'))).toBeNull();
  });

  it('keeps shared source platform-neutral', () => {
    const banned = [
      /from ['"]bun:/, /import\(\s*['"]bun:/, /from ['"]cloudflare:/, /import\(\s*['"]cloudflare:/,
      /\bcaches\b/, /\bnavigator\b/, /\.cf\b/, /\bWebSocketPair\b/, /\bDurableObject\w*\b/,
      /\bD1Database\b/, /\bRateLimit\b/, /\bKVNamespace\b/, /\bR2Bucket\b/, /\bQueue\b/, /\bFetcher\b/,
      /\bAi\b/, /\bVectorizeIndex\b/, /\bDispatchNamespace\b/, /\bAnalyticsEngineDataset\b/, /\bHyperdrive\b/,
      /\bExecutionContext\b/, /\bScheduledController\b/, /\bEmailMessage\b/,
      /cf-connecting-ip/i, /x-forwarded-for/i, /x-real-ip/i, /true-client-ip/i, /x-client-ip/i, /\bforwarded\b/i, /x-cluster-client-ip/i,
    ];
    for (const f of sharedFiles()) {
      const t = readFileSync(f, 'utf8');
      for (const p of banned) expect({ file: f, pattern: String(p), matched: p.test(t) }).toEqual({ file: f, pattern: String(p), matched: false });
    }
  });

  it('carries no rationale, counterfactual, or deferral comments', () => {
    const banned = [
      /\b(later plan|for now|TODO|will be added)\b/i,
      /\bwithout this\b/i,
      /\b(because|rationale|the reason|since|otherwise|workaround)\b/i,
      /\b(previously|used to|was |historically|see plan|rev \d|review)\b/i,
    ];
    for (const f of [...files(SRC), ...files(TESTS), ...files(join(WORKER, 'scripts'))]) {
      const comments = commentText(readFileSync(f, 'utf8'));
      for (const p of banned) expect({ file: f, pattern: String(p), matched: p.test(comments) }).toEqual({ file: f, pattern: String(p), matched: false });
    }
  });

  it('leads every index on a project-scoped table with project_id', () => {
    for (const s of SCHEMA_DDL.filter((x) => /CREATE (UNIQUE )?INDEX .* ON (sessions|events)\b/.test(x))) {
      expect(s).toMatch(/\(project_id/);
    }
  });

  it('keeps the committed schema.sql identical to the rendered schema', () => {
    expect(readFileSync(join(WORKER, 'schema.sql'), 'utf8')).toBe(renderSchemaSql());
  });

  it('declares no insecure switch in wrangler.toml', () => {
    expect(readFileSync(join(WORKER, 'wrangler.toml'), 'utf8')).not.toMatch(/ALLOW_INSECURE/);
  });

  it('retains telemetry through wrangler observability', () => {
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    expect(toml).toMatch(/\[observability\]\s*\nenabled = true/);
    expect(toml).toMatch(/\[observability\.logs\]\s*\ninvocation_logs = false/);
  });
});
