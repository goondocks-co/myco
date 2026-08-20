import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_ROUTES, ROUTES } from '@myco-server-worker/routes.js';
import worker from '@myco-server-worker/index.js';
import { createIngestThrottle } from './helpers/throttle.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, RETRY_AFTER_SECONDS, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { envelope as fixture, memberHeaders, sqliteEnv, uuid, PROTOCOL } from './helpers/fixtures.js';

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

/** Every `emit` call across src; a call removed or added moves the total. */
const EMIT_CALLS = 17;
/** The one migrations directory: the emit script writes it, the rendered-steps gate verifies it, and wrangler.toml applies from it. */
const MIGRATIONS_DIR = 'migrations';
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

/** Every token of a TypeScript source but its trivia, with the span it occupies; regex literals and template substitutions are re-scanned so a slash or a brace inside one is never taken for punctuation. */
function tokensOf(source: string): { kind: number; text: string; start: number; end: number }[] {
  const scanner = createScanner(false, undefined, source);
  const out: { kind: number; text: string; start: number; end: number }[] = [];
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
    if (kind !== K.WhitespaceTrivia && kind !== K.NewLineTrivia && kind !== K.SingleLineCommentTrivia && kind !== K.MultiLineCommentTrivia) {
      last = kind;
      out.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
    }
  }
  return out;
}

/** The object argument of every `emit({ ... })` call in a source, each taken from its opening brace to the brace that matches it, so a nested object never hides the tail of a call from the scan. */
function emitArguments(source: string): string[] {
  const tokens = tokensOf(source);
  const out: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (!(tokens[i].kind === K.Identifier && tokens[i].text === 'emit' && tokens[i + 1].kind === K.OpenParenToken && tokens[i + 2].kind === K.OpenBraceToken)) continue;
    let depth = 0;
    for (let j = i + 2; j < tokens.length; j += 1) {
      if (tokens[j].kind === K.OpenBraceToken) depth += 1;
      else if (tokens[j].kind === K.CloseBraceToken && (depth -= 1) === 0) { out.push(source.slice(tokens[i + 2].end, tokens[j].start)); break; }
    }
  }
  return out;
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

const envelope = (over: Record<string, unknown> = {}) => JSON.stringify(fixture(over));
const memberPost = (token: string, body: string) => new Request('https://s/events', { method: 'POST', headers: memberHeaders(token), body });

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

  it('serves no retired 1.4.x route, and every retired route names a catalogued kind or a served route as its replacement', async () => {
    const served = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const r of RETIRED_ROUTES) {
      expect(served.has(`${r.method} ${r.path}`)).toBe(false);
      expect(r.replacedBy.length).toBeGreaterThan(0);
      for (const target of r.replacedBy) expect({ target, known: served.has(target) || kindSpec(target) !== null }).toEqual({ target, known: true });
      const anonymous = await worker.fetch(withSource(r.path, { method: r.method, body: '{}' }), env());
      expect({ path: r.path, status: anonymous.status }).toEqual({ path: r.path, status: 401 });
      const e = sqliteEnv();
      const t = await issueMemberToken(e.db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
      const member = await worker.fetch(new Request(`https://s${r.path}`, { method: r.method, headers: memberHeaders(t.token), body: '{}' }), e.env);
      expect({ path: r.path, status: member.status }).toEqual({ path: r.path, status: 401 });
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
        headers: memberHeaders(token, { 'x-myco-project': 'proj_1', 'x-myco-machine': 'machine_1', 'x-myco-token': t1.tokenId }),
        body: JSON.stringify(fixture(spoof)),
      });
    expect(await (await worker.fetch(post(t1.token, {}), e)).json()).toEqual({ persisted: true, projected: true });
    expect(await (await worker.fetch(post(t2.token, {}), e)).json()).toEqual({ persisted: true, projected: true });
    for (const spoof of [{ projectId: 'proj_1' }, { tokenId: t1.tokenId }, { machineId: 'machine_1' }]) {
      const res = await worker.fetch(post(t2.token, { ...spoof, eventId: uuid(99) }), e);
      expect(await res.json()).toEqual({ persisted: false, reason: `unknown field ${Object.keys(spoof)[0]}` });
    }
    const sessions = sqlite.query(`SELECT project_id, machine_id, created_by_token_id FROM sessions ORDER BY project_id`).all();
    expect(sessions).toEqual([
      { project_id: 'proj_1', machine_id: 'machine_1', created_by_token_id: t1.tokenId },
      { project_id: 'proj_2', machine_id: 'machine_2', created_by_token_id: t2.tokenId },
    ]);
    const events = sqlite.query(`SELECT project_id, token_id FROM events ORDER BY project_id`).all();
    expect(events).toEqual([{ project_id: 'proj_1', token_id: t1.tokenId }, { project_id: 'proj_2', token_id: t2.tokenId }]);
  });

  it('projects sessions only from stored events, so an unstored request by another token cannot open or move a session', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_3' }, Date.now());
    expect(await (await worker.fetch(memberPost(t1.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT * FROM sessions`).all();
    expect(await (await worker.fetch(memberPost(t3.token, envelope({ createdAt: 0, payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)).json()).toEqual({ persisted: false, reason: 'machine identity mismatch' });
    expect(await (await worker.fetch(memberPost(t3.token, envelope({ sessionId: 'sess_new', payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)).json()).toEqual({ persisted: false, reason: 'machine identity mismatch' });
    expect(await (await worker.fetch(memberPost(t3.token, envelope()), e)).json()).toEqual({ persisted: false, reason: 'machine identity mismatch' });
    expect(sqlite.query(`SELECT * FROM sessions`).all()).toEqual(before);
    expect((sqlite.query(`SELECT COUNT(*) c FROM sessions`).get() as any).c).toBe(1);
  });

  it('answers 401 to an authenticated member on an unmatched route, charging its own token bucket and never the shared source bucket', async () => {
    const { env: e, db, sourceKeys, tokenKeys } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const paths = ['/nope', '/events/stop', '/v2/events'];
    for (const path of paths) {
      const res = await worker.fetch(withSource(path, { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, ...PROTOCOL }, body: '{}' }), e);
      expect(res.status).toBe(401);
    }
    expect(sourceKeys).toEqual([]);
    expect(tokenKeys).toEqual(paths.map(() => t1.tokenId));
  });

  it('keys the token limiter on the issued token id and never on credential material', async () => {
    const { env: e, db, tokenKeys } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const digest = await sha256Hex(t1.token);
    for (let i = 0; i < 3; i++) {
      const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, ...PROTOCOL }, body: '{}' }), e);
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
    const body = envelope({ payload: { promptId: uuid(2), text: 'x'.repeat(200), origin: 'user' } });
    const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, ...PROTOCOL }, body }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, reason: 'token write quota exceeded' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b).toBe(MEMBER_TOKEN_BYTE_QUOTA - 100);
  });

  it('charges the quota only for a stored event: a replay and another machine\'s attempt leave bytes_written unchanged', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_3' }, Date.now());
    const body = envelope();
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true, projected: true });
    const charged = (sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b;
    expect(charged).toBe(new TextEncoder().encode(body).byteLength);
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true, duplicate: true });
    expect(await (await worker.fetch(memberPost(t3.token, body), e)).json()).toEqual({ persisted: false, reason: 'machine identity mismatch' });
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t1.tokenId) as any).b).toBe(charged);
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(t3.tokenId) as any).b).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(1);
  });

  it('refuses a reused event id whose payload differs, keeping the stored event', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    expect(await (await worker.fetch(memberPost(t1.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const res = await worker.fetch(memberPost(t1.token, envelope({ payload: { promptId: uuid(2), text: 'other', origin: 'user' } })), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, reason: 'event id conflict' });
    expect((sqlite.query(`SELECT payload FROM events`).get() as any).payload).toBe(JSON.stringify(fixture().payload));
  });

  it('refuses every member request with 503 in the route\'s own refusal shape when the database schema version is not this build\'s', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(SERVER_SCHEMA_VERSION + 1));
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ persisted: false, reason: 'unavailable' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    const blob = await worker.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1.token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL, 'content-type': 'text/plain', 'content-length': '1' },
      body: 'x',
    }), e);
    expect(blob.status).toBe(503);
    expect(await blob.json()).toEqual({ stored: false, reason: 'unavailable' });
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

  it('never cancels or releases a request stream anywhere under src', () => {
    for (const f of files(SRC)) {
      const t = readFileSync(f, 'utf8');
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
    expect(src('::ffff:01.02.03.04')).toBe('1.2.3.4');
    expect(src('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(src('::ffff:999.1.1.1')).toBeNull();
    expect(src('01.02.03.04')).toBe('1.2.3.4');
    expect(src('999.1.1.1')).toBeNull();
    expect(src('1.2.3')).toBeNull();
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
    for (const s of SCHEMA_DDL.filter((x) => /CREATE (UNIQUE )?INDEX .* ON (?!member_tokens\b)\w+/.test(x))) {
      expect(s).toMatch(/\(project_id/);
    }
  });

  it('re-applies every schema statement but ADD COLUMN over an up-to-date database, so a half-applied migration can be re-run', () => {
    const db = new Database(':memory:');
    for (const s of SCHEMA_DDL) db.exec(s);
    for (const s of SCHEMA_DDL.filter((x) => !/ALTER TABLE \w+ ADD COLUMN/.test(x))) {
      expect({ statement: s.slice(0, 60), threw: (() => { try { db.exec(s); return null; } catch (e) { return String((e as Error).message); } })() })
        .toEqual({ statement: s.slice(0, 60), threw: null });
    }
    db.close();
  });

  it('keeps the committed migrations directory identical to the rendered steps', () => {
    for (const f of renderMigrationFiles()) expect(readFileSync(join(WORKER, MIGRATIONS_DIR, f.name), 'utf8')).toBe(f.sql);
  });

  it('declares an auth kind and a body mode for every route, and drives every non-public route through the deployed entry from its own fixture: a malformed request is refused in the route\'s shape, and a token without a machine identity is refused every write, storing nothing and charging nothing', async () => {
    const { env: e, db, sqlite, bucket } = sqliteEnv();
    const t1 = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const anonymous = await issueMemberToken(db, { projectId: 'proj_1', machineId: null }, Date.now());
    const KEY = 'a'.repeat(64);
    const bytes = new TextEncoder().encode('blob-bytes');
    const key = await sha256Hex('blob-bytes');
    /** Per non-public route: a malformed request the route refuses, and a well-formed one it would store. */
    const FIXTURES: Record<string, { shape: 'persisted' | 'stored'; malformed: (token: string) => Request; wellFormed: (token: string) => Request }> = {
      'POST /events': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/events', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/events', { method: 'POST', headers: memberHeaders(token), body: envelope() }),
      },
      'POST /blobs/{sha256}': {
        shape: 'stored',
        malformed: (token) => new Request(`https://s/blobs/${KEY}`, { method: 'POST', headers: memberHeaders(token, { 'content-type': 'nonsense', 'content-length': '2' }), body: '{}' }),
        wellFormed: (token) => new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(token, { 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes }),
      },
    };
    expect(ROUTES.filter((r) => r.auth !== 'public').map((r) => `${r.method} ${r.path}`).sort()).toEqual(Object.keys(FIXTURES).sort());
    const machineless: Record<string, unknown>[] = [];
    for (const r of ROUTES) {
      expect(['public', 'member']).toContain(r.auth);
      expect(['none', 'json', 'stream']).toContain(r.bodyMode);
      if (r.auth === 'public') continue;
      const fixture = FIXTURES[`${r.method} ${r.path}`];
      const res = await worker.fetch(fixture.malformed(t1.token), e);
      expect({ route: r.path, status: res.status }).toEqual({ route: r.path, status: 200 });
      const body = await res.json() as Record<string, unknown>;
      expect({ route: r.path, refused: body[fixture.shape] === false }).toEqual({ route: r.path, refused: true });
      const refused = await worker.fetch(fixture.wellFormed(anonymous.token), e);
      machineless.push({ route: r.path, status: refused.status, body: await refused.json() });
    }
    expect(machineless).toEqual(Object.entries(FIXTURES).map(([route, f]) => ({ route: route.slice('POST '.length), status: 200, body: { [f.shape]: false, reason: 'token has no machine identity' } })));
    expect({ events: (sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c, blobs: (sqlite.query(`SELECT COUNT(*) c FROM blobs`).get() as any).c, puts: bucket.puts }).toEqual({ events: 0, blobs: 0, puts: [] });
    expect((sqlite.query(`SELECT bytes_written b FROM member_tokens WHERE id = ?`).get(anonymous.tokenId) as any).b).toBe(0);
    for (const [, fixture] of Object.entries(FIXTURES)) {
      const stored = await (await worker.fetch(fixture.wellFormed(t1.token), e)).json() as Record<string, unknown>;
      expect(stored[fixture.shape]).toBe(true);
    }
  });

  it('emits only fixed classifiers as telemetry reasons', () => {
    // `reason?: Classifier` on the event type is the proof; this holds the type in place and reads each call whole.
    // The argument is taken to its matching brace, never to the first one, so a nested object cannot hide the tail
    // of a call from the scan.
    expect(readFileSync(join(SRC, 'telemetry.ts'), 'utf8')).toMatch(/interface TelemetryEvent \{[^}]*\breason\?: Classifier;/);
    let scanned = 0;
    for (const f of files(SRC)) {
      const t = readFileSync(f, 'utf8');
      for (const call of emitArguments(t)) {
        scanned += 1;
        for (const m of call.matchAll(/\breason\b\s*(?::\s*([^,]+))?/g)) {
          const value = (m[1] ?? '').trim();
          const fixed = /^'[^']*'$/.test(value) || value === 'classifier';
          expect({ file: f, value, fixed }).toEqual({ file: f, value, fixed: true });
        }
      }
    }
    expect(scanned).toBe(EMIT_CALLS);
  });

  // The compile-time proof itself is `npm run check`, which is a separate lane from this suite. This gate holds the
  // declarations in place so the proof cannot be deleted silently; it asserts their presence, not their satisfaction.
  it('keeps a declared adapter proof for every platform binding, so the compile-time check has something to prove', () => {
    const platform = readFileSync(join(SRC, 'platform', 'cloudflare.ts'), 'utf8');
    // Each proof names two types, and the gate reads both: an adapter checked against itself compiles and proves
    // nothing, so the second argument must be the platform's own type. Those types come from the platform's ambient
    // declarations, which the adapter file never imports — a name it did import would not be the platform's.
    const declared = new Map(
      [...platform.matchAll(/export type (_\w+) = AssertAssignable<\s*(\w+)\s*,\s*(\w+)\s*>;/g)].map((m) => [m[1], [m[2], m[3]]] as const),
    );
    for (const [proof, adapter, binding] of [
      ['_D1Satisfies', 'D1Like', 'D1Database'],
      ['_RateLimitSatisfies', 'RateLimiter', 'RateLimit'],
      ['_BlobStoreSatisfies', 'BlobStoreLike', 'R2Bucket'],
    ]) {
      expect({ proof, args: declared.get(proof) ?? null }).toEqual({ proof, args: [adapter, binding] });
      expect({ proof, imported: new RegExp(`\\b${binding}\\b`).test(platform.slice(0, platform.indexOf('type AssertAssignable'))) })
        .toEqual({ proof, imported: false });
    }
    expect(declared.size).toBe(3);
    expect(platform).toMatch(/type AssertAssignable<A, B extends A> = B;/);
  });

  it('pins the retired 1.4.x wire routes, so the retirement cannot be forgotten by emptying the list', () => {
    expect(RETIRED_ROUTES.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'POST /context/subagent',
      'POST /events/stop',
      'POST /events/sync-transcript-prompts',
      'POST /routed-capture/plan',
      'POST /routed-capture/transcript',
      'POST /sessions/register',
      'POST /sessions/unregister',
    ]);
  });

  it('never rewrites a session\'s identity columns on receipt: a second token of the same machine moves only the last receipt', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const first = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    const second = await issueMemberToken(db, { projectId: 'proj_1', machineId: 'machine_1' }, Date.now());
    expect(await (await worker.fetch(memberPost(first.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get();
    expect(before).toEqual({ machine_id: 'machine_1', created_by_token_id: first.tokenId, first_received_at: expect.any(Number) });
    expect(await (await worker.fetch(memberPost(second.token, envelope({ eventId: uuid(70), payload: { promptId: uuid(71), text: 'next', origin: 'user' } })), e)).json()).toEqual({ persisted: true, projected: true });
    expect(sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get()).toEqual(before);
  });

  it('binds every Env key in wrangler.toml, declares no binding Env does not name, and applies migrations from the directory the schema gates verify', () => {
    const envSource = readFileSync(join(SRC, 'env.ts'), 'utf8');
    const block = /export interface Env \{([^}]*)\}/.exec(envSource);
    expect(block).not.toBeNull();
    const keys = [...block![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    expect(keys.length).toBeGreaterThan(0);
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    const bound = [...toml.matchAll(/^(?:binding|name) = "(\w+)"$/gm)].map((m) => m[1]).filter((name) => name !== 'myco-server').sort();
    expect(bound).toEqual(keys);
    expect(/^migrations_dir = "([^"]*)"$/m.exec(toml)?.[1]).toBe(MIGRATIONS_DIR);
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
