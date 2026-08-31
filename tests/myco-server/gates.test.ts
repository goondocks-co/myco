import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_ROUTES, ROUTES, grantRoutes, isOwnedPath, ownedPathPatterns, type Shape } from '@myco-server-worker/routes.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import worker from '@myco-server-worker/index.js';
import { createIngestThrottle } from './helpers/throttle.js';
import { issueMemberToken, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, PROJECT_HEADER, RETRY_AFTER_SECONDS, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { envelope as fixture, memberHeaders, sqliteEnv, uuid, PROTOCOL, count } from './helpers/fixtures.js';
import { OWNER_ENV as OWNER_ENV2, ownerCookie as ownerCookie2 } from './helpers/owner.js';

const WORKER = fileURLToPath(new URL('../../packages/myco-server/', import.meta.url));
const SRC = join(WORKER, 'src');
const TESTS = fileURLToPath(new URL('./', import.meta.url));

/** The `[assets]` table of the deploy config, up to the next table header. */
function assetsBlock(): string {
  const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
  const start = toml.indexOf('[assets]');
  expect(start).toBeGreaterThan(-1);
  const rest = toml.slice(start + '[assets]'.length);
  const end = rest.search(/^\[/m);
  return end === -1 ? rest : rest.slice(0, end);
}
const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
const files = (dir: string): string[] => allFiles(dir).filter((f) => f.endsWith('.ts'));
/**
 * Shared code: everything that is neither a platform adapter nor an entry point.
 * Those are the only places a platform may be named. `src/index.ts` counts as an
 * entry point — it is the module the hosted deployment names as its main — and a
 * separate gate pins it to a single re-export so it cannot grow logic.
 */
const sharedFiles = () =>
  files(SRC).filter((f) =>
    !f.includes(`${join(SRC, 'platform')}/`) && !f.includes(`${join(SRC, 'entry')}/`) && f !== join(SRC, 'index.ts'));

/** Every `emit` call across src; a call removed or added moves the total. */
const EMIT_CALLS = 51;
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
import { createServer } from '../pipeline.js';
import { cloudflareSourceOf, serverEnvFromBindings, type CloudflareBindings, type DeferredWork } from '../platform/cloudflare/env.js';
const server = createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf, fetchImpl: (input, init) => fetch(input, init) });
export async function handleRequest(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork): Promise<Response> {
  return server.handleRequest(request, serverEnvFromBindings(bindings, deferred));
}
export default { fetch: handleRequest };
`;

const CANONICAL_INDEX = `export { default, handleRequest } from './entry/cloudflare.js';
export { HarnessContainer } from './platform/cloudflare/harness-container.js';`;

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
      const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      const member = await worker.fetch(new Request(`https://s${r.path}`, { method: r.method, headers: memberHeaders(t.token), body: '{}' }), e.env);
      expect({ path: r.path, status: member.status }).toEqual({ path: r.path, status: 401 });
    }
  });

  it('refuses every declared non-public route without a credential, via the deployed entry — and the one route that takes an enrollment authority instead still refuses a key it does not hold', async () => {
    for (const r of ROUTES.filter((x) => x.auth !== 'public' && x.auth !== 'enroll')) {
      const res = await worker.fetch(withSource(r.path, { method: r.method, body: r.method === 'GET' ? undefined : '{}' }), env());
      expect(res.status).toBe(401);
    }
    // The join route answers 200 with a refusal rather than 401: it has no credential to
    // reject. Its admission is the key, so the property to hold is that a key the
    // Deployment never minted buys nothing — checked here so the exemption above cannot
    // quietly become an unauthenticated route that admits.
    const enroll = ROUTES.filter((x) => x.auth === 'enroll');
    expect(enroll.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /members/join']);
    const e = sqliteEnv();
    for (const key of ['x'.repeat(43), 'not-a-key', '']) {
      const res = await worker.fetch(withSource('/members/join', { method: 'POST', body: JSON.stringify({ key, machineId: 'machine_9' }) }), e.env);
      expect({ key: key.slice(0, 8), status: res.status, body: await res.json() })
        .toEqual({ key: key.slice(0, 8), status: 200, body: { joined: false, code: 'enrollment_unknown', reason: 'enrollment key unknown' } });
    }
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as any).c).toBe(0);
  });

  it('keeps every entry point to wiring: the pipeline and its own platform, and nothing that decides', () => {
    const entries = files(join(SRC, 'entry'));
    expect(entries.length).toBeGreaterThan(1);
    for (const f of entries) {
      const imports = [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect({ file: f, imports: imports.length }).not.toEqual({ file: f, imports: 0 });
      // An entry may reach only ITS OWN platform, derived from its filename, so one
      // target's entry cannot quietly depend on the other target's adapter.
      const own = `/platform/${f.split('/').pop()!.replace(/\.ts$/, '')}/`;
      for (const spec of imports) {
        const allowed = spec.endsWith('/pipeline.js') || spec.includes(own) || spec.startsWith('bun:');
        expect({ file: f, spec, allowed, own }).toEqual({ file: f, spec, allowed: true, own });
      }
    }
  });

  it('keeps the entry point identical to the canonical wiring shape', () => {
    expect(normalize(readFileSync(join(SRC, 'entry', 'cloudflare.ts'), 'utf8'))).toBe(normalize(CANONICAL_ENTRY));
    expect(normalize(readFileSync(join(SRC, 'index.ts'), 'utf8'))).toBe(normalize(CANONICAL_INDEX));
  });

  it('takes tenancy and attribution from the authenticated token only, via the deployed entry', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t2 = await issueMemberToken(db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    // The URL, the machine header and the token header all name t1's identity whoever
    // holds the request. Only `x-myco-project` is honoured — it is the request's project
    // scope, not an attribution claim — so each token writes into its own project and
    // the two machines never contend for one session row.
    const post = (token: string, project: string, spoof: Record<string, unknown>) =>
      new Request(`https://s/events?projectId=proj_1&tokenId=${t1.tokenId}&machineId=machine_1`, {
        method: 'POST',
        headers: memberHeaders(token, { 'x-myco-project': project, 'x-myco-machine': 'machine_1', 'x-myco-token': t1.tokenId }),
        body: JSON.stringify(fixture(spoof)),
      });
    expect(await (await worker.fetch(post(t1.token, 'proj_1', {}), e)).json()).toEqual({ persisted: true, projected: true });
    expect(await (await worker.fetch(post(t2.token, 'proj_2', {}), e)).json()).toEqual({ persisted: true, projected: true });
    for (const spoof of [{ projectId: 'proj_1' }, { tokenId: t1.tokenId }, { machineId: 'machine_1' }]) {
      const res = await worker.fetch(post(t2.token, 'proj_2', { ...spoof, eventId: uuid(99) }), e);
      expect(await res.json()).toEqual({ persisted: false, code: 'unknown_field', reason: `unknown field ${Object.keys(spoof)[0]}` });
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
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, Date.now());
    expect(await (await worker.fetch(memberPost(t1.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT * FROM sessions`).all();
    expect(await (await worker.fetch(memberPost(t3.token, envelope({ createdAt: 0, payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)).json()).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await (await worker.fetch(memberPost(t3.token, envelope({ sessionId: 'sess_new', payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)).json()).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await (await worker.fetch(memberPost(t3.token, envelope()), e)).json()).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(sqlite.query(`SELECT * FROM sessions`).all()).toEqual(before);
    expect((sqlite.query(`SELECT COUNT(*) c FROM sessions`).get() as any).c).toBe(1);
  });

  it('answers 401 to an authenticated member on an unmatched route, charging its own token bucket and never the shared source bucket', async () => {
    const { env: e, db, sourceKeys, tokenKeys } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const paths = ['/nope', '/events/stop', '/v2/events'];
    for (const path of paths) {
      const res = await worker.fetch(withSource(path, { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, ...PROTOCOL }, body: '{}' }), e);
      expect(res.status).toBe(401);
    }
    expect(sourceKeys).toEqual([]);
    expect(tokenKeys).toEqual(paths.map(() => t1.tokenId));
  });

  it('admits an External Agent grant on exactly one route', () => {
    expect(grantRoutes()).toEqual(['POST /mcp']);
  });

  it('names the credential class on every failed authentication it records, from a fixed pair of literals', () => {
    const seen: string[] = [];
    for (const f of files(SRC)) {
      for (const call of emitArguments(readFileSync(f, 'utf8'))) {
        if (!/kind:\s*'auth_failed'/.test(call)) continue;
        const credential = /credential:\s*('[a-z]+')/.exec(call)?.[1] ?? 'absent';
        seen.push(credential);
      }
    }
    expect(seen.sort()).toEqual(["'grant'", "'member'"]);
  });

  it('tells an authenticated principal a served path\'s methods only among the routes it could reach: a member is told 405 on a member path and 401 on an owner, auth or enrollment path; a grant is told 405 on the grant route alone', async () => {
    const { env: e, db } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const grant = await issueExternalGrant(db, { projectId: 'proj_1' }, null, 'mem_machine_1', Date.now());
    const concrete = (path: string) => path.replace(/\{(sha256|key)\}/g, 'a'.repeat(64)).replace(/\{tier\}/g, '1').replace(/\{[^}]+\}/g, 'a');
    const asMember = (path: string) => worker.fetch(withSource(path, { method: 'PATCH', headers: { authorization: `Bearer ${t1.token}`, ...PROTOCOL } }), e);
    const asGrant = (path: string) => worker.fetch(withSource(path, { method: 'PATCH', headers: { authorization: `Bearer ${grant.key}` } }), e);
    const outcomes: Record<string, unknown>[] = [];
    for (const r of ROUTES) {
      if (r.auth === 'public') continue;
      const path = concrete(r.path);
      const member = await asMember(path);
      const asGrantRes = await asGrant(path);
      outcomes.push({ route: `${r.auth} ${r.method} ${r.path}`, member: member.status, memberAllow: member.headers.get('allow'), grant: asGrantRes.status, grantAllow: asGrantRes.headers.get('allow') });
    }
    const memberPaths = new Set(ROUTES.filter((r) => r.auth === 'member').map((r) => concrete(r.path)));
    const grantPaths = new Set(grantRoutes().map((s) => concrete(s.slice(s.indexOf(' ') + 1))));
    expect(outcomes).toEqual(ROUTES.filter((r) => r.auth !== 'public').map((r) => {
      const path = concrete(r.path);
      const memberMethods = [...new Set(ROUTES.filter((m) => m.auth === 'member' && concrete(m.path) === path).map((m) => m.method))].sort().join(', ');
      const grantMethods = [...new Set(ROUTES.filter((m) => m.auth === 'member' && m.bodyMode === 'json' && m.grant !== undefined && concrete(m.path) === path).map((m) => m.method))].sort().join(', ');
      return {
        route: `${r.auth} ${r.method} ${r.path}`,
        member: memberPaths.has(path) ? 405 : 401, memberAllow: memberPaths.has(path) ? memberMethods : null,
        grant: grantPaths.has(path) ? 405 : 401, grantAllow: grantPaths.has(path) ? grantMethods : null,
      };
    }));
  });

  it('keys the token limiter on the issued token id and never on credential material', async () => {
    const { env: e, db, tokenKeys } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
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
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA - 100, t1.tokenId);
    const body = envelope({ payload: { promptId: uuid(2), text: 'x'.repeat(200), origin: 'user' } });
    const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, [PROJECT_HEADER]: 'proj_1', ...PROTOCOL }, body }), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b).toBe(MEMBER_TOKEN_BYTE_QUOTA - 100);
  });

  it('charges the quota only for a stored event: a replay and another machine\'s attempt leave bytes_written unchanged', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, Date.now());
    const body = envelope();
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true, projected: true });
    const charged = (sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b;
    expect(charged).toBe(new TextEncoder().encode(body).byteLength);
    expect(await (await worker.fetch(memberPost(t1.token, body), e)).json()).toEqual({ persisted: true, duplicate: true });
    expect(await (await worker.fetch(memberPost(t3.token, body), e)).json()).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b).toBe(charged);
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t3.tokenId) as any).b).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(1);
  });

  it('refuses a reused event id whose payload differs, keeping the stored event', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await (await worker.fetch(memberPost(t1.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const res = await worker.fetch(memberPost(t1.token, envelope({ payload: { promptId: uuid(2), text: 'other', origin: 'user' } })), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persisted: false, code: 'event_id_conflict', reason: 'event id conflict' });
    expect((sqlite.query(`SELECT payload FROM events`).get() as any).payload).toBe(JSON.stringify(fixture().payload));
  });

  it('refuses every member request with 503 in the route\'s own refusal shape when the database schema version is not this build\'s', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(SERVER_SCHEMA_VERSION + 1));
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ persisted: false, code: 'unavailable', reason: 'unavailable' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    const blob = await worker.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1.token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL, 'content-type': 'text/plain', 'content-length': '1' },
      body: 'x',
    }), e);
    expect(blob.status).toBe(503);
    expect(await blob.json()).toEqual({ stored: false, code: 'unavailable', reason: 'unavailable' });
    sqlite.query(`DELETE FROM schema_meta`).run();
    expect((await worker.fetch(memberPost(t1.token, envelope()), e)).status).toBe(503);
  });

  it('answers a post-auth storage failure with 503 and retry-after, never 200', async () => {
    const { env: e, db, sqlite } = sqliteEnv();
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`DROP TABLE events`).run();
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(RETRY_AFTER_SECONDS));
    expect(await res.json()).toEqual({ persisted: false, code: 'unavailable', reason: 'unavailable' });
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
      /\bD1_ERROR\b/, /\bD1\b/, /\bR2\b/, /\bcloudflare\b/i, /\bwrangler\b/i, /\bvectorize\b/i, /\bworkers?\.dev\b/i,
      /\bdurable object\b/i, /from ['"]node:/, /import\(\s*['"]node:/,
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
    // Credential and membership tables are Deployment-scoped by design — a member
    // credential belongs to a member and a Deployment, not to one project — so
    // their indexes lead with what they are actually looked up by.
    const deploymentScoped = /ON (member_tokens|members|member_credentials|enrollment_authorities|step_up_authorities|identity_link_authorities)\b/;
    // Two indexes are keyed on the credential rather than the project: a credential
    // spans every Project in its Deployment, so the quota admission looks reservations
    // up by credential, and the foreign key on a run's dispatching credential is
    // checked by credential alone. Both have to lead with what they are read by.
    const byCredential = /idx_blob_reservations_credential|idx_agent_runs_credential|idx_external_grants_hash|idx_events_token_only/;
    for (const s of SCHEMA_DDL.filter((x) => /CREATE (UNIQUE )?INDEX .* ON \w+/.test(x) && !deploymentScoped.test(x) && !byCredential.test(x))) {
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

  it('declares an auth kind, a body mode and a shape for every route, and drives every non-public route through the deployed entry from its own fixture: a malformed request is refused in the route\'s shape with a code, and a token without a machine identity is refused every write, storing nothing and charging nothing', async () => {
    const { env: e, db, sqlite, bucket } = sqliteEnv();
    /** Issued far enough back that the refresh window is open now, and far enough forward that the tokens are live. */
    const issuedAt = Date.now() - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2);
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    const anonymous = await issueMemberToken(db, { memberId: 'mem_anon', machineId: null }, issuedAt);
    const KEY = 'a'.repeat(64);
    // The run routes reference an agent identity and a project, both of which a
    // Deployment declares before any run is claimed.
    let runSeq = 0;
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(issuedAt);
    sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_gate', 'gate', 'built-in', 1, ?)`).run(issuedAt);
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'gate')`).run(issuedAt);
    const bytes = new TextEncoder().encode('blob-bytes');
    const key = await sha256Hex('blob-bytes');
    /** Per non-public route: a malformed request the route refuses, and a well-formed one it would store. */
        // One run the write fixtures may report against: a report on an unknown run
    // is refused, and a fixture must be a single accepted request.
    sqlite.query(`INSERT OR IGNORE INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'run_gate', 'user', 'gate', 'running', 1)`).run();

    const FIXTURES: Record<string, { shape: Shape; malformed: (token: string) => Request; wellFormed: (token: string) => Request }> = {
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
      'POST /tokens/refresh': {
        shape: 'refreshed',
        malformed: (token) => new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
        wellFormed: (token) => new Request('https://s/tokens/refresh', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      },
      'POST /runs/claim': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/claim', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/claim', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: `run_${runSeq++}`, agentId: 'agent_gate', task: `digest_${runSeq}`, maxAgeSeconds: 3600, capability: 'cortex' }) }),
      },
      'POST /runs/admission': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/admission', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/admission', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ capability: 'cortex' }) }),
      },
      'POST /runs/get': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/get', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/get', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope' }) }),
      },
      'POST /runs/update': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/update', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/update', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope', update: { status: 'failed' } }) }),
      },
      'POST /runs/failed': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/failed', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/failed', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope', errorClass: 'other', error: 'boom' }) }),
      },
      'POST /runs/resume-admission': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/resume-admission', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/resume-admission', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope' }) }),
      },
      'POST /runs/supersede': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/supersede', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/supersede', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ excludeRunId: 'nope', agentId: 'agent_gate', taskName: 'digest', dryRun: false }) }),
      },
      'POST /runs/reports': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/reports', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/reports', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'nope' }) }),
      },
      'POST /runs/report': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/report', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/report', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ runId: 'run_gate', agentId: 'user', action: 'gate', summary: 's' }) }),
      },
      'POST /runs/events': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/events', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/events', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ events: [{ runId: 'nope', eventType: 'phase_start' }] }) }),
      },
      'POST /runs/cortex-instructions': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/cortex-instructions', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/cortex-instructions', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ agentId: 'agent_gate', content: 'c', inputHash: 'h' }) }),
      },
      'POST /spores/save': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/spores/save', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/spores/save', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: `sp_${runSeq++}`, agentId: 'agent_gate', observationType: 'gotcha', content: 'c' }) }),
      },
      'POST /spores/list': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/spores/list', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
        wellFormed: (token) => new Request('https://s/spores/list', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      },
      'POST /spores/get': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/spores/get', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/spores/get', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ id: 'nope' }) }),
      },
      'POST /spores/resolve': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/spores/resolve', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/spores/resolve', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ eventId: `re_${runSeq++}`, agentId: 'agent_gate', sporeId: 'nope', action: 'obsolete', status: 'obsolete' }) }),
      },
      'POST /runs/state/read': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/state/read', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/state/read', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ agentId: 'agent_gate', key: 'k' }) }),
      },
      'POST /runs/state/write': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/runs/state/write', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
        wellFormed: (token) => new Request('https://s/runs/state/write', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ agentId: 'agent_gate', key: `k_${runSeq++}`, value: 'v' }) }),
      },
      'POST /mcp': {
        shape: 'answered',
        malformed: (token) => new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
        wellFormed: (token) => new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
      },
      'POST /members/link-github': {
        shape: 'persisted',
        malformed: (token) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: 'not json' }),
        wellFormed: (token) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' }),
      },
    };
    /** How each shape answers: the status of a terminal refusal, where its code and reason sit, and what a well-formed request that stored or answered looks like. */
    const SHAPES: Record<Shape, { refusedStatus: number; refusal: (body: any) => { refused: boolean; code: unknown; reason: unknown }; accepted: (body: any) => boolean }> = {
      persisted: { refusedStatus: 200, refusal: (b) => ({ refused: b.persisted === false, code: b.code, reason: b.reason }), accepted: (b) => b.persisted === true },
      stored: { refusedStatus: 200, refusal: (b) => ({ refused: b.stored === false, code: b.code, reason: b.reason }), accepted: (b) => b.stored === true },
      refreshed: { refusedStatus: 200, refusal: (b) => ({ refused: b.refreshed === false, code: b.code, reason: b.reason }), accepted: (b) => b.refreshed === true },
      answered: { refusedStatus: 400, refusal: (b) => ({ refused: b.jsonrpc === '2.0' && b.id === null && typeof b.error === 'object', code: b.error?.data?.code, reason: b.error?.message }), accepted: (b) => Array.isArray(b.result?.tools) },
    };
    expect(ROUTES.filter((r) => r.auth === 'member').map((r) => `${r.method} ${r.path}`).sort()).toEqual(Object.keys(FIXTURES).sort());
    const machineless: Record<string, unknown>[] = [];
    for (const r of ROUTES) {
      expect(['public', 'member', 'auth', 'owner', 'enroll']).toContain(r.auth);
      if (r.auth === 'auth' || r.auth === 'owner' || r.auth === 'enroll') continue;
      expect(['none', 'json', 'stream']).toContain(r.bodyMode);
      if (r.auth === 'public') continue;
      const fixture = FIXTURES[`${r.method} ${r.path}`];
      expect({ route: r.path, shape: r.shape }).toEqual({ route: r.path, shape: fixture.shape });
      const answers = SHAPES[fixture.shape];
      const res = await worker.fetch(fixture.malformed(t1.token), e);
      expect({ route: r.path, status: res.status }).toEqual({ route: r.path, status: answers.refusedStatus });
      const refusal = answers.refusal(await res.json());
      expect({ route: r.path, refused: refusal.refused, coded: typeof refusal.code === 'string' }).toEqual({ route: r.path, refused: true, coded: true });
      const refused = await worker.fetch(fixture.wellFormed(anonymous.token), e);
      machineless.push({ route: r.path, status: refused.status, ...answers.refusal(await refused.json()) });
    }
    expect(machineless).toEqual(Object.entries(FIXTURES).map(([route, f]) => ({ route: route.slice('POST '.length), status: SHAPES[f.shape].refusedStatus, refused: true, code: 'no_machine_identity', reason: 'token has no machine identity' })));
    expect({ events: (sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c, blobs: (sqlite.query(`SELECT COUNT(*) c FROM blobs`).get() as any).c, puts: bucket.puts }).toEqual({ events: 0, blobs: 0, puts: [] });
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(anonymous.tokenId) as any).b).toBe(0);
    for (const [route, fixture] of Object.entries(FIXTURES)) {
      const stored = await (await worker.fetch(fixture.wellFormed(t1.token), e)).json();
      expect({ route, accepted: SHAPES[fixture.shape].accepted(stored) }).toEqual({ route, accepted: true });
    }
  });

  it('writes settings and capability admission from exactly one module, keyed on the tables themselves', () => {
    // Keying this on MODULE PATHS alone would not hold: the read-layer allowlist
    // already permits every file under `ingest/` and `db/` to issue SQL, so a
    // settings write from the ingest path would pass that gate untouched. The
    // property is about the TABLES, so the gate is too — their names may appear
    // only where they are owned.
    //
    // What it protects is the write ORDER. Validate, authorize, persist, record the
    // actor, re-arm. A second writer is how one of those five goes missing on one
    // path, and the one that goes missing silently is the actor.
    const OWNED: Record<string, string> = {
      deployment_settings: join('core', 'settings.ts'),
      project_capabilities: join('core', 'settings.ts'),
      deployment_secrets: join('core', 'secrets.ts'),
    };
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel.startsWith(`db${sep}`)) continue; // migrations create them
      // Comments are stripped first: the property is about a second WRITER, and a
      // docstring that names a table in prose is not one. Scanning raw source made
      // the gate fire on its own explanation of what it protects.
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const [table, owner] of Object.entries(OWNED)) {
        if (rel === owner) continue;
        if (new RegExp(`\\b${table}\\b`).test(source)) offenders.push(`${rel} names ${table}`);
      }
    }
    expect(offenders).toEqual([]);

    // And the owner really does carry every step, so the gate is guarding something.
    const settings = readFileSync(join(SRC, 'core', 'settings.ts'), 'utf8');
    for (const step of ['authorize(', 'updated_by', 'rearm(']) {
      expect({ step, present: settings.includes(step) }).toEqual({ step, present: true });
    }
  });

  it('schedules work past an answer from exactly one module, and that module is the events route', () => {
    // `afterResponse` is the one way a request leaves work behind. Holding its
    // callers to the events route keeps every deferred piece of work a consequence
    // of a capture the caller made, never of a read or a refusal.
    const callers = files(SRC)
      .filter((f) => /\bafterResponse\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => !f.startsWith('platform/') && !f.startsWith('core/adapters'));
    expect(callers).toEqual([join('ingest', 'events.ts')]);
  });

  it('opens a Deployment secret from exactly one function under src, and no display surface calls it', () => {
    // `get()` is the only thing that returns a credential. The whole point of
    // sealing values is defeated if a settings page, a status route or a log line
    // can reach one, so the callers are held to those that must authenticate
    // something. `describe()` and `list()` exist precisely so a surface never needs
    // to.
    const store = readFileSync(join(SRC, 'core', 'secrets.ts'), 'utf8');
    expect(store.match(/crypto\.subtle\.decrypt/g)).toHaveLength(1);
    expect(store).toMatch(/additionalData: encoder\.encode\(name\)/);

    // Keyed on CONSTRUCTION, not on a variable name. Matching `secrets.get(` or
    // `secretStore.get(` missed `store.get(` — which is what the one file that
    // builds a store actually calls its local, and is the most natural form for the
    // first real consumer to use. A gate that green-lights the change it exists to
    // catch is worse than none.
    const callers = files(SRC)
      .filter((f) => f !== join(SRC, 'core', 'secrets.ts'))
      .filter((f) => /deploymentSecretStore\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC.length + 1));
    // The settings surface, which only ever calls `describe`/`list`/`put`/`delete`,
    // and the titler, which opens a provider credential to call the provider and
    // hands it to nothing else. A new file here is the thing to look at.
    expect(callers.sort()).toEqual([join('api', 'settings.ts'), join('core', 'titling.ts')]);
    const surface = stripComments(readFileSync(join(SRC, 'api', 'settings.ts'), 'utf8'));
    expect(surface).not.toMatch(/\.get\(\s*ctx\.params\.name/);
  });

  it('never spreads a whole byte array into a call, which is a divergence no test on one engine can catch', () => {
    // `String.fromCharCode(...bytes)` passes one argument per byte, and the two
    // runtimes disagree about how many a call may take: JSC accepts a 320KB spread,
    // V8 throws at roughly 125k. The suite runs on one engine, so a spread version
    // passes here and fails on the other target — the failure is invisible to every
    // test and visible only in the source. Hence a gate rather than a case.
    for (const file of files(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const m of source.matchAll(/String\.fromCharCode\(\s*\.\.\.\s*([A-Za-z0-9_.]+)/g)) {
        // A bounded slice is fine; an unbounded identifier is not.
        expect({ file: file.slice(SRC.length + 1), spread: m[1], bounded: /subarray|slice/.test(m[0]) })
          .toEqual({ file: file.slice(SRC.length + 1), spread: m[1], bounded: true });
      }
    }
  });

  it('seals every Deployment secret under a key the store does not hold', () => {
    // A wrapping key that ever landed in the database it protects silently undoes
    // the separation the ciphertext column exists to create.
    const schema = readFileSync(join(SRC, 'db', 'schema.ts'), 'utf8');
    const table = schema.match(/CREATE TABLE IF NOT EXISTS deployment_secrets[\s\S]*?`/)![0];
    for (const forbidden of ['wrap', 'key_material', 'plaintext', 'preview', 'masked']) {
      expect({ forbidden, present: table.toLowerCase().includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    expect(table).toContain('ciphertext');
    expect(table).toContain('key_version');
  });

  it('reaches no live statement at member_tokens: the credential store is the only table the running server reads or writes', () => {
    // The V5 move is atomic or it is broken for everyone but the person testing it. A
    // surviving read would authenticate against rows the backfill deliberately revoked;
    // a surviving write would charge quota to a table nothing else consults, refusing
    // every new member as `quota` while backfilled credentials kept working.
    //
    // Two references are legitimate and named here rather than pattern-matched away:
    // the historical migration chain, which must keep naming the table it created and
    // read from, and the CHECK constraint literal `classify()` matches to mark a quota
    // violation terminal.
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel === join('db', 'schema.ts')) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!/\bmember_tokens\b/.test(line)) continue;
        if (rel === 'telemetry.ts' && line.includes('member_tokens_quota')) continue;
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('inserts into member_credentials from exactly one live-issuing statement under src, and the migration backfill can only land revoked rows', () => {
    const inserting = files(SRC).filter((f) => /INTO member_credentials\b/.test(readFileSync(f, 'utf8')));
    // The schema's backfill is the one other writer. It is bounded here rather than
    // waved through: every row it lands carries a revoked_at, so the exemption cannot
    // become a path that mints a live credential outside the live-token predicate.
    expect(inserting).toEqual([join(SRC, 'auth', 'tokens.ts'), join(SRC, 'db', 'schema.ts')]);
    const backfill = readFileSync(join(SRC, 'db', 'schema.ts'), 'utf8').match(/INSERT (OR IGNORE )?INTO member_credentials[\s\S]*?`/)![0];
    expect(backfill.match(/INTO member_credentials\b/g)).toHaveLength(1);
    expect(backfill).toMatch(/COALESCE\(t\.revoked_at, t\.expires_at\)/);
    expect(backfill).not.toMatch(/\bNULL\b\s*(,|$)[^`]*--\s*revoked/);
    const tokens = readFileSync(join(SRC, 'auth', 'tokens.ts'), 'utf8');
    expect(tokens.match(/INTO member_credentials\b/g)).toHaveLength(1);
    expect(tokens).toMatch(/INSERT INTO member_credentials \([^)]*\)\s+SELECT \?, \?, \?, \?, \?, \?, NULL, 0, \?, \?, \?, NULL, \?, \?\s+WHERE \? IS NULL OR \$\{TOKEN_LIVE\}`/);
    expect(tokens).toMatch(/UPDATE member_credentials SET revoked_at = \? WHERE predecessor_id = \? AND revoked_at IS NULL AND first_used_at IS NULL AND \$\{TOKEN_LIVE\}`/);
    expect(readFileSync(join(SRC, 'ingest', 'quota.ts'), 'utf8')).toMatch(/export const TOKEN_LIVE = 'EXISTS \(SELECT 1 FROM member_credentials WHERE id = \? AND revoked_at IS NULL\)';/);
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
    const platform = readFileSync(join(SRC, 'platform', 'cloudflare', 'env.ts'), 'utf8');
    // Each proof names two types, and the gate reads both: an adapter checked against itself compiles and proves
    // nothing, so the second argument must be the platform's own type. Those types come from the platform's ambient
    // declarations, which the adapter file never imports — a name it did import would not be the platform's.
    const declared = new Map(
      [...platform.matchAll(/export type (_\w+) = AssertAssignable<\s*(\w+)\s*,\s*(\w+)\s*>;/g)].map((m) => [m[1], [m[2], m[3]]] as const),
    );
    for (const [proof, adapter, binding] of [
      ['_RelationalSatisfies', 'RelationalStore', 'D1Database'],
      ['_RateLimitSatisfies', 'RateLimiter', 'RateLimit'],
      ['_BlobStoreSatisfies', 'BlobStore', 'R2Bucket'],
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
    const first = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const second = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await (await worker.fetch(memberPost(first.token, envelope()), e)).json()).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get();
    expect(before).toEqual({ machine_id: 'machine_1', created_by_token_id: first.tokenId, first_received_at: expect.any(Number) });
    expect(await (await worker.fetch(memberPost(second.token, envelope({ eventId: uuid(70), payload: { promptId: uuid(71), text: 'next', origin: 'user' } })), e)).json()).toEqual({ persisted: true, projected: true });
    expect(sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get()).toEqual(before);
  });

  it('binds every Env key in wrangler.toml, declares no binding Env does not name, and applies migrations from the directory the schema gates verify', () => {
    const envSource = readFileSync(join(SRC, 'platform', 'cloudflare', 'env.ts'), 'utf8');
    const block = /export interface CloudflareBindings extends OwnerBindings \{([^}]*)\}/.exec(envSource);
    expect(block).not.toBeNull();
    const keys = [...block![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    expect(keys.length).toBeGreaterThan(0);
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    // HARNESS is optional in Env — absent in local dev and the parity harness —
    // so it sits outside the required-binding equality, like SECRET_WRAP_KEY.
    const bound = [...toml.matchAll(/^(?:binding|name) = "(\w+)"$/gm)].map((m) => m[1]).filter((name) => name !== 'myco-server' && name !== 'HARNESS').sort();
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
  it('pins the credential-free route set, so it cannot grow silently', () => {
    const free = ROUTES.filter((r) => r.auth === 'public' || r.auth === 'auth').map((r) => `${r.method} ${r.path}`).sort();
    expect(free).toEqual(['GET /auth/callback', 'GET /auth/login', 'GET /health']);
  });

  it('serves a signed-in account ahead of membership on exactly the two routes that link it, and every other owner route runs for a member', () => {
    const optional = ROUTES.filter((r) => r.auth === 'owner' && r.membership === 'optional').map((r) => `${r.method} ${r.path}`).sort();
    expect(optional).toEqual(['GET /auth/me', 'POST /auth/link']);
    const context = readFileSync(join(SRC, 'context.ts'), 'utf8');
    expect(context).toMatch(/export interface OwnerContext \{[^}]*\n  member: DashboardMember;\n/);
    const importers = files(SRC).filter((f) => /\bSessionContext\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length + 1)).sort();
    expect(importers).toEqual(['api/identity.ts', 'context.ts', 'routes.ts']);
  });

  it('compares no session to a configured owner: who may enter is a membership question', () => {
    for (const f of [...files(SRC), ...files(join(WORKER, 'scripts'))]) {
      expect({ file: f, named: /OWNER_GITHUB_ID|ownerGithubId/.test(readFileSync(f, 'utf8')) }).toEqual({ file: f, named: false });
    }
    expect(readFileSync(join(WORKER, 'wrangler.toml'), 'utf8')).not.toMatch(/OWNER_GITHUB_ID/);
  });

  it('never lets the shell be framed, on either target', () => {
    const headers = readFileSync(join(WORKER, 'ui', 'public', '_headers'), 'utf8');
    expect(headers).toMatch(/^\/\*\n  X-Frame-Options: DENY\n  Content-Security-Policy: frame-ancestors 'none'\n/);
    const bun = readFileSync(join(SRC, 'platform', 'bun', 'static.ts'), 'utf8');
    expect(bun).toContain("'x-frame-options': 'DENY'");
    expect(bun).toContain("frame-ancestors 'none'");
  });

  it('gives no credential-free route access to the bindings by type', () => {
    const source = readFileSync(join(SRC, 'routes.ts'), 'utf8');
    expect(source).toContain('export type PublicHandler = (request: Request) => Promise<Response>');
    expect(source).toContain('export type AuthHandler = (request: Request, ctx: AuthContext) => Promise<Response>');
    expect(source).not.toMatch(/AuthHandler = \([^)]*Env/);
  });

  it('answers every owner route without disclosing the protocol number', async () => {
    const owner = ROUTES.filter((r) => r.auth === 'owner');
    expect(owner.length).toBeGreaterThan(0);
    const { OWNER_ENV, ownerCookie } = await import('./helpers/owner.js');
    const cookie = await ownerCookie();
    for (const r of owner) {
      const path = r.path.replace('{projectId}', 'proj_1').replace('{sessionId}', 's1').replace('{runId}', 'r1').replace('{memberId}', 'mem_machine_2').replace('{grantId}', 'eg_x').replace('{id}', 'x').replace('{child}', 'prompts').replace('{key}', 'a'.repeat(64));
      const e = sqliteEnv();
      const res = await worker.fetch(
        new Request(`https://s${path}`, { method: r.method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }, body: r.method === 'POST' ? '{}' : undefined }),
        { ...e.env, ...OWNER_ENV }
      );
      expect({ path, protocol: res.headers.get('x-myco-protocol') }).toEqual({ path, protocol: null });
    }
  });

  it('keeps the deploy config well formed: every line is a comment, a table header, or a key', () => {
    // An edit that leaves debris in wrangler.toml breaks every deploy and every `wrangler dev`,
    // and no test reads this file for shape. A bare array line survived one such edit here.
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    const malformed = toml
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.length > 0 && !line.startsWith('#'))
      .filter(({ line }) => !/^\[\[?[A-Za-z0-9_.]+\]\]?$/.test(line) && !/^[A-Za-z0-9_]+\s*=/.test(line) && !/^[\]}]/.test(line) && !/^["'\d]/.test(line));
    expect(malformed).toEqual([]);
  });

  it('names in run_worker_first exactly the paths the server owns, live and retired, so the shell answers nothing the server should', () => {
    const list = /^run_worker_first = \[([^\]]*)\]$/m.exec(assetsBlock())?.[1] ?? '';
    const patterns = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(patterns).toEqual(ownedPathPatterns());
    for (const { path } of [...ROUTES, ...RETIRED_ROUTES]) {
      expect({ path, owned: isOwnedPath(path, patterns) }).toEqual({ path, owned: true });
    }
  });

  it('serves the shell from the edge store in the platform\'s own shape, and declares no asset binding the server never reads', () => {
    const assets = assetsBlock();
    expect(assets).toMatch(/^directory = "ui\/dist"$/m);
    expect(assets).toMatch(/^not_found_handling = "single-page-application"$/m);
    expect(assets).not.toMatch(/^binding = /m);
  });

  it('pins the full route table, so no route of any kind is added without a decision', () => {
    expect(ROUTES.map((r) => `${r.auth} ${r.method} ${r.path}`).sort()).toEqual([
      'auth GET /auth/callback',
      'auth GET /auth/login',
      'enroll POST /members/join',
      'member POST /blobs/{sha256}',
      'member POST /events',
      'member POST /mcp',
      'member POST /members/link-github',
      'member POST /runs/admission',
      'member POST /runs/claim',
      'member POST /runs/cortex-instructions',
      'member POST /runs/events',
      'member POST /runs/failed',
      'member POST /runs/get',
      'member POST /runs/report',
      'member POST /runs/reports',
      'member POST /runs/resume-admission',
      'member POST /runs/state/read',
      'member POST /runs/state/write',
      'member POST /runs/supersede',
      'member POST /runs/update',
      'member POST /spores/get',
      'member POST /spores/list',
      'member POST /spores/resolve',
      'member POST /spores/save',
      'member POST /tokens/refresh',
      'owner DELETE /api/secrets/{name}',
      'owner GET /api/agents',
      'owner GET /api/credentials',
      'owner GET /api/credentials/{id}/activity',
      'owner GET /api/enrollment',
      'owner GET /api/members',
      'owner GET /api/projects',
      'owner GET /api/projects/{projectId}/activity',
      'owner GET /api/projects/{projectId}/blobs/{key}',
      'owner GET /api/projects/{projectId}/capabilities',
      'owner GET /api/projects/{projectId}/cortex/instructions',
      'owner GET /api/projects/{projectId}/digests',
      'owner GET /api/projects/{projectId}/digests/{tier}/revisions',
      'owner GET /api/projects/{projectId}/grants',
      'owner GET /api/projects/{projectId}/release-states',
      'owner GET /api/projects/{projectId}/runs',
      'owner GET /api/projects/{projectId}/runs/{runId}',
      'owner GET /api/projects/{projectId}/sessions',
      'owner GET /api/projects/{projectId}/sessions/{sessionId}',
      'owner GET /api/projects/{projectId}/sessions/{sessionId}/transcript',
      'owner GET /api/projects/{projectId}/sessions/{sessionId}/{child}',
      'owner GET /api/projects/{projectId}/skills',
      'owner GET /api/projects/{projectId}/skills/{skillId}',
      'owner GET /api/projects/{projectId}/spores',
      'owner GET /api/projects/{projectId}/spores/{sporeId}',
      'owner GET /api/secrets',
      'owner GET /api/settings',
      'owner GET /api/status',
      'owner GET /auth/me',
      'owner PATCH /api/projects/{projectId}',
      'owner POST /api/credentials/{id}/revoke',
      'owner POST /api/enrollment',
      'owner POST /api/enrollment/{id}/revoke',
      'owner POST /api/harness/probe',
      'owner POST /api/members/{memberId}/revoke',
      'owner POST /api/projects',
      'owner POST /api/projects/{projectId}/archive',
      'owner POST /api/projects/{projectId}/grants',
      'owner POST /api/projects/{projectId}/grants/{grantId}/revoke',
      'owner POST /api/projects/{projectId}/grants/{grantId}/rotate',
      'owner POST /api/projects/{projectId}/unarchive',
      'owner POST /auth/link',
      'owner POST /auth/logout',
      'owner PUT /api/agents/{agentId}',
      'owner PUT /api/projects/{projectId}/capabilities/{capability}',
      'owner PUT /api/secrets/{name}',
      'owner PUT /api/settings/{leaf}',
      'public GET /health',
    ]);
  });

  it('declares every required binding that the adapter requires, and no more', () => {
    const envSource = readFileSync(join(SRC, 'platform', 'cloudflare', 'env.ts'), 'utf8');
    const required = [...(/REQUIRED_BINDINGS = \[([^\]]*)\]/.exec(envSource)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const block = /export interface CloudflareBindings extends OwnerBindings \{([\s\S]*?)\n\}/.exec(envSource);
    const mandatory = [...block![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    expect(required).toEqual(mandatory);
    expect(required.length).toBeGreaterThan(0);
  });

  it('maps every required binding onto a capability', () => {
    // A binding added to a target without a capability naming it is invisible
    // on the status surface: the deployment reports itself fully capable while
    // an operator has something unconfigured.
    const envSource = readFileSync(join(SRC, 'platform', 'cloudflare', 'env.ts'), 'utf8');
    const required = [...(/REQUIRED_BINDINGS = \[([^\]]*)\]/.exec(envSource)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    const declared = [...envSource.matchAll(/operatorNames: \[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1]!.matchAll(/'(\w+)'/g)].map((n) => n[1]));

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it('states each capability once, in wording neither target owns', () => {
    for (const target of ['cloudflare', 'bun']) {
      const source = readFileSync(join(SRC, 'platform', target, 'env.ts'), 'utf8');
      const ids = [...source.matchAll(/capability: '([a-z-]+)'/g)].map((m) => m[1]).sort();
      // Both targets answer for the same set, so a surface can say the same
      // sentence on either one.
      expect({ target, ids }).toEqual({ target, ids: ['blob-store', 'rate-limiting', 'relational-store'] });

      const labels = [...source.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
      for (const label of labels) {
        // Product wording, not the operator's: a label carrying a binding name
        // is the vocabulary split this replaced.
        expect({ target, label, mentionsBinding: /MYCO_|BUCKET|LIMIT/.test(label) })
          .toEqual({ target, label, mentionsBinding: false });
      }
    }
  });

  it('names no platform binding in shared code: the status surface reports what the platform declares', () => {
    const status = readFileSync(join(SRC, 'api', 'status.ts'), 'utf8');
    expect(status).not.toMatch(/REQUIRED_BINDINGS = \[/);
    for (const name of ['MYCO_DB', 'BUCKET', 'SOURCE_LIMIT', 'TOKEN_LIMIT']) {
      expect({ name, named: new RegExp(`\\b${name}\\b`).test(status) }).toEqual({ name, named: false });
    }
  });

  it('verifies no cookie on the member path', () => {
    const pipeline = readFileSync(join(SRC, 'pipeline.ts'), 'utf8');
    // The member path starts where the owner branch closes inside `run()`, not at
    // `member()` — the bearer read and the anonymous refusal live above that function,
    // and a slice starting there would never see the code it is meant to constrain.
    const memberSection = pipeline.slice(pipeline.indexOf('const presented = bearer(request);'));
    expect(memberSection).not.toContain('verifySession');
    expect(memberSection).not.toContain('readCookie');
    expect(memberSection).not.toContain('ownerConfig');
  });
  it('pins the server\'s runtime dependencies: every package src imports is declared, every runtime dependency is imported by shared source, and the runtime set is exactly the one decided', () => {
    const manifest = JSON.parse(readFileSync(join(WORKER, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const runtime = manifest.dependencies ?? {};
    const declared = new Set([...Object.keys(runtime), ...Object.keys(manifest.devDependencies ?? {})]);
    const packageOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    const unquote = (text: string): string => text.slice(1, -1);
    /** Every module specifier a source names — static imports and re-exports in any layout, side-effect imports, and dynamic imports — read from the token stream so a declaration spread over lines is seen. */
    const specifiers = (source: string): string[] => {
      const tokens = tokensOf(source);
      const out: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind !== K.ImportKeyword && t.kind !== K.ExportKeyword) continue;
        if (t.kind === K.ImportKeyword && tokens[i + 1]?.kind === K.StringLiteral) { out.push(unquote(tokens[i + 1].text)); continue; }
        if (t.kind === K.ImportKeyword && tokens[i + 1]?.kind === K.OpenParenToken && tokens[i + 2]?.kind === K.StringLiteral) { out.push(unquote(tokens[i + 2].text)); continue; }
        for (let j = i + 1; j < tokens.length; j++) {
          const u = tokens[j];
          if (u.kind === K.SemicolonToken || u.kind === K.ImportKeyword || u.kind === K.ExportKeyword) break;
          if (u.kind === K.FromKeyword && tokens[j + 1]?.kind === K.StringLiteral) { out.push(unquote(tokens[j + 1].text)); break; }
        }
      }
      return out
        .filter((spec) => !spec.startsWith('.') && !spec.startsWith('/') && !/^(bun|node|cloudflare):/.test(spec))
        .map(packageOf);
    };
    expect(specifiers("import {\n  a,\n  b,\n} from 'pkg-a/sub';\nexport * from '@scope/pkg-b';\nimport 'pkg-c';\nconst x = await import('pkg-d');\nimport type { T } from './local.js';")).toEqual(['pkg-a', '@scope/pkg-b', 'pkg-c', 'pkg-d']);
    const imported = new Map<string, Set<string>>();
    for (const f of files(SRC)) for (const pkg of specifiers(readFileSync(f, 'utf8'))) (imported.get(pkg) ?? imported.set(pkg, new Set()).get(pkg)!).add(f);
    expect([...imported.keys()].filter((pkg) => !declared.has(pkg))).toEqual([]);
    const shared = new Set(sharedFiles());
    expect(Object.keys(runtime).filter((pkg) => ![...(imported.get(pkg) ?? [])].some((f) => shared.has(f)))).toEqual([]);
    expect(runtime).toEqual({ '@modelcontextprotocol/server': '2.0.0' });
  });

  it('leaves owner routes ingest-neutral', async () => {
    const e = sqliteEnv();
    const before = count(e.sqlite, 'events');
    const res = await worker.fetch(
      new Request('https://s/api/projects', { headers: { cookie: await ownerCookie2(), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV2 }
    );
    expect(res.status).toBe(200);
    expect(count(e.sqlite, 'events')).toBe(before);
    expect(e.executed.filter((sql) => /UPDATE\s+member_credentials/i.test(sql))).toEqual([]);
  });
});
