import routeLedger from '../fixtures/server/route-ledger.json';
import { jsonBody } from '../helpers/json-body.js';
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_ROUTES, ROUTES, SESSION_AUTHORITIES, UNSERVED_PATHS, grantRoutes, isOwnedPath, ownedPathPatterns, type Shape } from '@myco-server-worker/routes.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import worker from '@myco-server-worker/index.js';
import { createIngestThrottle } from './helpers/throttle.js';
import { MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS, mintMemberToken, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { issueMemberToken } from './helpers/member-token.js';
import { PROJECT_HEADER, RETRY_AFTER_SECONDS, SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { cloudflareSourceOf } from '@myco-server-worker/platform/cloudflare/source.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { RUN_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { envelope as fixture, memberHeaders, sqliteEnv, uuid, PROTOCOL, count, RETIRED_BYTE_CEILING, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { isDeploymentAccessPath } from './helpers/access-paths.js';
import { isForeignKeyChildIndex } from './helpers/foreign-key-indexes.js';
import { OWNER_ENV as OWNER_ENV2, ownerCookie as ownerCookie2 } from './helpers/owner.js';
import { memberRouteFixtures } from './helpers/member-route-fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { REPOSITORY_CHECKOUT_CAPABILITY } from '@goondocks/myco-shared/repository';

const WORKER = fileURLToPath(new URL('../../packages/myco-server/', import.meta.url));
const SRC = join(WORKER, 'src');

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

/** The one migrations directory: the emit script writes it, the rendered-steps gate verifies it, and wrangler.toml applies from it. */
const MIGRATIONS_DIR = 'migrations';
const K = SyntaxKind as unknown as Record<string, number>;
const EXPRESSION_END = new Set<number>([
  K.Identifier, K.NumericLiteral, K.BigIntLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateTail,
  K.CloseParenToken, K.CloseBracketToken, K.CloseBraceToken, K.PlusPlusToken, K.MinusMinusToken, K.RegularExpressionLiteral,
  K.ThisKeyword, K.NullKeyword, K.TrueKeyword, K.FalseKeyword, K.SuperKeyword,
]);


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


const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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
/** A route's path with every parameter filled by a value of the shape it accepts. */
const concretePath = (path: string) => path.replace(/\{(sha256|key)\}/g, 'a'.repeat(64)).replace('{promptId}', uuid(1)).replace('{planKey}', '00000000-0000-5000-8000-000000000002')
  .replace('{memberId}', 'mem_machine_2').replace('{projectId}', 'proj_1').replace(/\{tier\}/g, '1').replace(/\{[^}]+\}/g, 'a');
/** Every stored row, table by table: what a request that must change nothing is held to. */
const storedRows = (sqlite: Database) => Object.fromEntries(
  (sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name").all() as { name: string }[])
    .map(({ name }) => [name, sqlite.query(`SELECT * FROM "${name}"`).all()]));

describe('gates', () => {
  it('keeps the public set to exactly /health', () => {
    expect(ROUTES.filter((r) => r.auth === 'public').map((r) => `${r.method} ${r.path}`)).toEqual(['GET /health']);
  });

  it('refuses probed paths absent from the route table, via the deployed entry', async () => {
    expect(UNSERVED_PATHS).toEqual(['/.well-known/*', '/register']);
    for (const path of PROBE_PATHS) {
      for (const method of ['GET', 'POST']) {
        const res = await worker.fetch(withSource(path, { method, body: method === 'POST' ? '{}' : undefined }), env());
        expect({ method, path, status: res.status }).toEqual({ method, path, status: isOwnedPath(path, UNSERVED_PATHS) ? 404 : 401 });
      }
    }
  });

  it('serves no retired 1.4.x route, and every retired route names a catalogued kind or a served route as its replacement, or says what it carried is dropped', async () => {
    const served = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const r of RETIRED_ROUTES) {
      expect(served.has(`${r.method} ${r.path}`)).toBe(false);
      expect({ path: r.path, answered: r.replacedBy.length > 0 || (r.dropped !== undefined && r.dropped.length > 0) }).toEqual({ path: r.path, answered: true });
      for (const target of r.replacedBy) expect({ target, known: served.has(target) || kindSpec(target) !== null || RUN_TOOLS.some(tool => tool === target) }).toEqual({ target, known: true });
      const anonymous = await worker.fetch(withSource(r.path, { method: r.method, body: '{}' }), env());
      expect({ path: r.path, status: anonymous.status }).toEqual({ path: r.path, status: 401 });
      const e = sqliteEnv({ workerLogin: true });
      const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      const member = await worker.fetch(new Request(`https://s${r.path}`, { method: r.method, headers: memberHeaders(t.token), body: '{}' }), e.env);
      expect({ path: r.path, status: member.status }).toEqual({ path: r.path, status: 401 });
    }
  });


  it('refuses credential-free access to protected routes; public enrollment grants nothing without admitted evidence', async () => {
    for (const r of ROUTES.filter((x) => x.auth !== 'public' && x.auth !== 'enroll')) {
      const res = await worker.fetch(withSource(r.path, { method: r.method, body: r.method === 'GET' ? undefined : '{}' }), env());
      if (r.path === '/auth/me' || r.path === '/auth/login') {
        expect(res.status).toBe(401);
        expect(await res.json() as Record<string, unknown>).toMatchObject({ error: 'sign_in_unconfigured' });
      } else expect(res.status).toBe(401);
    }
    // Enrollment accepts protocol evidence in place of a member credential.
    const enroll = ROUTES.filter((x) => x.auth === 'enroll');
    expect(enroll.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /auth/device/start', 'POST /auth/device/poll', 'POST /auth/runner/start', 'POST /auth/runner/poll', 'POST /members/join']);
    const e = sqliteEnv({ workerLogin: true });
    for (const key of ['x'.repeat(43), 'not-a-key', '']) {
      const res = await worker.fetch(withSource('/members/join', { method: 'POST', body: JSON.stringify({ key, machineId: 'machine_9' }) }), e.env);
      expect({ key: key.slice(0, 8), status: res.status, body: await res.json() })
        .toEqual({ key: key.slice(0, 8), status: 200, body: { joined: false, code: 'enrollment_unknown', reason: 'enrollment key unknown' } });
    }
    const started = await worker.fetch(withSource('/auth/device/start', { method: 'POST',
      body: JSON.stringify({ machineId: 'unapproved_machine', machineName: 'Unapproved', os: 'linux' }),
    }), e.env);
    expect(started.status).toBe(200);
    const device = await started.json() as { device_code: string };
    const pending = await worker.fetch(withSource('/auth/device/poll', { method: 'POST', body: JSON.stringify({ device_code: device.device_code }) }), e.env);
    expect(await pending.json() as Record<string, unknown>).toEqual({ error: 'authorization_pending' });
    const unknown = await worker.fetch(withSource('/auth/device/poll', { method: 'POST', body: JSON.stringify({ device_code: 'x'.repeat(43) }) }), e.env);
    expect(await unknown.json() as Record<string, unknown>).toEqual({ error: 'invalid_grant' });
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get() as any).c).toBe(0);
    // A runner registration grants nothing until an owner or administrator approves it, and never answers a member poll.
    const runnerStart = await worker.fetch(withSource('/auth/runner/start', { method: 'POST',
      body: JSON.stringify({ name: 'mini', machineId: 'unapproved_runner', machineName: 'Mini', os: 'darwin', candidate: `mycorun_${'r'.repeat(43)}` }),
    }), e.env);
    expect(runnerStart.status).toBe(200);
    const registration = await runnerStart.json() as { device_code: string };
    const runnerPending = await worker.fetch(withSource('/auth/runner/poll', { method: 'POST', body: JSON.stringify({ device_code: registration.device_code }) }), e.env);
    expect(await runnerPending.json() as Record<string, unknown>).toEqual({ error: 'authorization_pending' });
    const crossed = await worker.fetch(withSource('/auth/device/poll', { method: 'POST', body: JSON.stringify({ device_code: registration.device_code }) }), e.env);
    expect(await crossed.json() as Record<string, unknown>).toEqual({ error: 'invalid_grant' });
    const memberAsRunner = await worker.fetch(withSource('/auth/runner/poll', { method: 'POST', body: JSON.stringify({ device_code: device.device_code }) }), e.env);
    expect(await memberAsRunner.json() as Record<string, unknown>).toEqual({ error: 'invalid_grant' });
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM runner_credentials`).get() as any).c).toBe(0);
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM runners`).get() as any).c).toBe(0);
  });

  it('takes tenancy and attribution from the authenticated token only, via the deployed entry', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
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
    expect(await jsonBody((await worker.fetch(post(t1.token, 'proj_1', {}), e)))).toEqual({ persisted: true, projected: true });
    expect(await jsonBody((await worker.fetch(post(t2.token, 'proj_2', {}), e)))).toEqual({ persisted: true, projected: true });
    for (const spoof of [{ projectId: 'proj_1' }, { tokenId: t1.tokenId }, { machineId: 'machine_1' }]) {
      const res = await worker.fetch(post(t2.token, 'proj_2', { ...spoof, eventId: uuid(99) }), e);
      expect(await jsonBody(res)).toEqual({ persisted: false, code: 'unknown_field', reason: `unknown field ${Object.keys(spoof)[0]}` });
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
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, Date.now());
    expect(await jsonBody((await worker.fetch(memberPost(t1.token, envelope()), e)))).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT * FROM sessions`).all();
    expect(await jsonBody((await worker.fetch(memberPost(t3.token, envelope({ createdAt: 0, payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await jsonBody((await worker.fetch(memberPost(t3.token, envelope({ sessionId: 'sess_new', payload: { promptId: uuid(2), text: 'squat', origin: 'user' } })), e)))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await jsonBody((await worker.fetch(memberPost(t3.token, envelope()), e)))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(sqlite.query(`SELECT * FROM sessions`).all()).toEqual(before);
    expect((sqlite.query(`SELECT COUNT(*) c FROM sessions`).get() as any).c).toBe(1);
  });

  it('answers 401 to an authenticated member on an unmatched route, charging its own token bucket and never the shared source bucket', async () => {
    const { env: e, db, sourceKeys, tokenKeys } = sqliteEnv({ workerLogin: true });
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

  it('names the credential class on every failed authentication it records', async () => {
    const e = sqliteEnv({ workerLogin: true });
    const elsewhere = sqliteEnv({ workerLogin: true });
    const strangerGrant = await issueExternalGrant(elsewhere.db, { projectId: 'proj_1' }, null, 'mem_machine_1', Date.now());
    const presented = [mintMemberToken(), strangerGrant.key, `mycorun_${'r'.repeat(43)}`];
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try {
      for (const bearer of presented) {
        const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, ...PROTOCOL }, body: '{}' }), e.env);
        expect(res.status).toBe(401);
      }
    } finally { console.log = log; }
    const recorded = lines.flatMap((line) => {
      try { const event = JSON.parse(line) as { kind?: string; credential?: string }; return event.kind === 'auth_failed' ? [event.credential] : []; } catch { return []; }
    });
    expect(recorded).toEqual(['member', 'grant', 'runner']);
  });

  it('tells an authenticated principal a served path\'s methods only among the routes it could reach: a member is told 405 on a member path and 401 on an owner, auth or enrollment path; a grant is told 405 on the grant route alone', async () => {
    const { env: e, db } = sqliteEnv({ workerLogin: true });
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
    const { env: e, db, tokenKeys } = sqliteEnv({ workerLogin: true });
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
    const { env: e, sourceKeys, tokenKeys } = sqliteEnv({ workerLogin: true });
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

  it('admits an event past the retired 1 GiB lifetime ceiling, and keeps counting it (#1416)', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(RETIRED_BYTE_CEILING, t1.tokenId);
    const body = envelope({ payload: { promptId: uuid(2), text: 'x'.repeat(200), origin: 'user' } });
    const res = await worker.fetch(withSource('/events', { method: 'POST', headers: { authorization: `Bearer ${t1.token}`, [PROJECT_HEADER]: 'proj_1', ...PROTOCOL }, body }), e);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ persisted: true, projected: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(1);
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b).toBe(RETIRED_BYTE_CEILING + new TextEncoder().encode(body).byteLength);
  });

  it('counts bytes only for a stored event: a replay and another machine\'s attempt leave bytes_written unchanged', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, Date.now());
    const body = envelope();
    expect(await jsonBody((await worker.fetch(memberPost(t1.token, body), e)))).toEqual({ persisted: true, projected: true });
    const charged = (sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b;
    expect(charged).toBe(new TextEncoder().encode(body).byteLength);
    expect(await jsonBody((await worker.fetch(memberPost(t1.token, body), e)))).toEqual({ persisted: true, duplicate: true });
    expect(await jsonBody((await worker.fetch(memberPost(t3.token, body), e)))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t1.tokenId) as any).b).toBe(charged);
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(t3.tokenId) as any).b).toBe(0);
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(1);
  });

  it('refuses a reused event id whose payload differs, keeping the stored event', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await jsonBody((await worker.fetch(memberPost(t1.token, envelope()), e)))).toEqual({ persisted: true, projected: true });
    const res = await worker.fetch(memberPost(t1.token, envelope({ payload: { promptId: uuid(2), text: 'other', origin: 'user' } })), e);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'event_id_conflict', reason: 'event id conflict' });
    expect((sqlite.query(`SELECT payload FROM events`).get() as any).payload).toBe(JSON.stringify(fixture().payload));
  });

  it('refuses every member request with 503 in the route\'s own refusal shape when the database schema version is not this build\'s', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`UPDATE schema_meta SET value = ? WHERE key = 'version'`).run(String(SERVER_SCHEMA_VERSION + 1));
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'unavailable', reason: 'unavailable' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);
    const blob = await worker.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t1.token}`, 'cf-connecting-ip': '1.2.3.4', ...PROTOCOL, 'content-type': 'text/plain', 'content-length': '1' },
      body: 'x',
    }), e);
    expect(blob.status).toBe(503);
    expect(await jsonBody(blob)).toEqual({ stored: false, code: 'unavailable', reason: 'unavailable' });
    sqlite.query(`DELETE FROM schema_meta`).run();
    expect((await worker.fetch(memberPost(t1.token, envelope()), e)).status).toBe(503);
  });

  it('answers a post-auth storage failure with 503 and retry-after, never 200', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    sqlite.query(`DROP TABLE events`).run();
    const res = await worker.fetch(memberPost(t1.token, envelope()), e);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(RETRY_AFTER_SECONDS));
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'unavailable', reason: 'unavailable' });
  });

  it('advertises the rate-limit window it is configured with', () => {
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    // The word alone, never the tail of a longer key: the container table names a `rollout_active_grace_period`.
    const periods = [...toml.matchAll(/\bperiod = (\d+)/g)].map((m) => Number(m[1]));
    expect(periods).toEqual([RETRY_AFTER_SECONDS, RETRY_AFTER_SECONDS]);
  });

  // Workers runtime: a handler that cancels or unlocks the request body stream the runtime owns breaks the request on the Worker, though Bun tolerates it.
  it('keeps request stream ownership with the runtime; only object-store readers own their readers', () => {
    for (const f of files(SRC)) {
      const t = readFileSync(f, 'utf8');
      if (f.endsWith('/core/search-index.ts') || f.endsWith('/core/embedding/reconcile.ts') || f.endsWith('/core/stored-object.ts') || f.endsWith('/core/event-content.ts') || f.endsWith('/core/registered-content.ts') || f.endsWith('/core/archive-bundle.ts') || f.endsWith('/platform/bun/file-body.ts')) {
        expect(t).not.toMatch(/\bRequest\b|\bRouteContext\b|\bServerEnv\b/);
        continue;
      }
      expect({ file: f, cancels: /\.cancel\(/.test(t), releases: /releaseLock\(/.test(t) }).toEqual({ file: f, cancels: false, releases: false });
    }
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

  it('leads every index on a project-scoped table with project_id', () => {
    // Credential and membership tables are Deployment-scoped by design — a member
    // credential belongs to a member and a Deployment, not to one project — so
    // their indexes lead with what they are actually looked up by.
    const deploymentScoped = /ON (member_tokens|members|member_naming_failures|member_credentials|enrollment_authorities|identity_link_authorities|identity_link_redemptions|backups)\b/;
    // An index read by a Deployment-wide access path leads with what it is read
    // by; the set of those, each with its read, is declared once in
    // `helpers/access-paths.ts` and shared with the v2-table gate.
    const { sqlite } = sqliteEnv();
    try {
      const liveIndexes = new Set(sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name));
      for (const s of SCHEMA_DDL.filter((x) => /CREATE (UNIQUE )?INDEX .* ON \w+/.test(x) && !deploymentScoped.test(x) && !isDeploymentAccessPath(x))) {
        const index = /INDEX IF NOT EXISTS (\w+) ON (\w+)/.exec(s)!;
        if (!liveIndexes.has(index[1]!)) continue;
        if (!isForeignKeyChildIndex(sqlite, index[2]!, index[1]!)) expect(s).toMatch(/\(project_id/);
      }
    } finally { sqlite.close(); }
  });

  it('re-applying numbered migrations leaves the current schema unchanged', async () => {
    const { applySchemaSteps } = await import('./helpers/migrate.js');
    const { sqliteRelationalStore } = await import('@myco-server-worker/platform/bun/sqlite.js');
    const { schemaSqlite } = await import('./helpers/schema-template.js');
    const db = schemaSqlite();
    try {
      const store = sqliteRelationalStore(db);
      const before = db.query(`SELECT name,sql FROM sqlite_master ORDER BY name`).all();
      expect(await applySchemaSteps(store)).toEqual([]);
      expect(db.query(`SELECT name,sql FROM sqlite_master ORDER BY name`).all()).toEqual(before);
    } finally { db.close(); }
  });

  it('declares an auth kind, a body mode and a shape for every route, and drives every non-public route through the deployed entry from its own fixture: a malformed request is refused in the route\'s shape with a code, and a token without a machine identity is refused every write, storing nothing and charging nothing', async () => {
    const { env: e, db, sqlite, bucket } = sqliteEnv({ workerLogin: true });
    /** Issued far enough back that the refresh window is open now, and far enough forward that the tokens are live. */
    const issuedAt = Date.now() - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2);
    const t1 = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    const revokeOnly = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    const anonymous = await issueMemberToken(db, { memberId: 'mem_anon', machineId: null }, issuedAt);
    const FIXTURES = await memberRouteFixtures(sqlite, issuedAt, { otherTokenId: t1.tokenId, machinelessToken: anonymous.token });
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
      expect(['public', 'member', 'auth', 'session', 'enroll', 'runner']).toContain(r.auth);
      if (r.auth === 'auth' || r.auth === 'session' || r.auth === 'enroll' || r.auth === 'runner') continue;
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
    expect(machineless).toEqual(ROUTES.filter((r) => r.auth === 'member').map((r) => {
      const route = `${r.method} ${r.path}`;
      const f = FIXTURES[route];
      const run = route.startsWith('POST /runs/');
      return { route: route.slice(route.indexOf(' ') + 1), status: SHAPES[f.shape].refusedStatus, refused: true,
        code: run ? 'run_scope' : 'no_machine_identity', reason: run ? "a run credential reaches only its run's surface" : 'token has no machine identity' };
    }));
    expect({ events: (sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c, blobs: (sqlite.query(`SELECT COUNT(*) c FROM blobs`).get() as any).c, puts: bucket.puts }).toEqual({ events: 0, blobs: 0, puts: [] });
    expect((sqlite.query(`SELECT bytes_written b FROM member_credentials WHERE id = ?`).get(anonymous.tokenId) as any).b).toBe(0);
    sqlite.run('UPDATE raw_provenance_backfill SET complete = 1 WHERE id = 1');
    const prepare = (route: string) => {
      if (route === 'POST /members/roles' || route === 'GET /members/raw-claims') sqlite.run("UPDATE deployment_ownership SET member_id='mem_machine_1' WHERE id=1");
      if (route === 'POST /members/ownership/transfer') sqlite.run("UPDATE members SET role='admin',github_id='gate-transfer' WHERE id='mem_machine_2'");
      if (route === 'POST /members/ownership') sqlite.run("UPDATE members SET github_id = 'gate-owner' WHERE id = 'mem_machine_1'");
    };
    for (const [route, fixture] of Object.entries(FIXTURES)) {
      prepare(route);
      const token = route === 'POST /members/credential/revoke' ? revokeOnly.token : t1.token;
      const stored = await (await worker.fetch(fixture.wellFormed(token), e)).json() as Record<string, unknown>;
      if (route.startsWith('POST /runs/')) expect({ route, code: stored.code, persisted: stored.persisted }).toEqual({ route, code: 'run_scope', persisted: false });
      else expect({ route, accepted: SHAPES[fixture.shape].accepted(stored) }).toEqual({ route, accepted: true });
    }
  });

  it('gives a credential minted not to rotate no authority on any member route: no credential, enrollment, link key, grant, ownership or role, no run credential, and neither the provider key nor a repository credential', async () => {
    const { env: e, db, sqlite, serverEnv } = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(sqlite);
    e.SECRET_WRAP_KEY = { get: async () => btoa('w'.repeat(32)) };
    const issuedAt = Date.now() - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2);
    const other = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt);
    const machineless = await issueMemberToken(db, { memberId: 'mem_anon', machineId: null }, issuedAt);
    const fixtures = await memberRouteFixtures(sqlite, issuedAt, { otherTokenId: other.tokenId, machinelessToken: machineless.token });
    // What a door could hand out: a provider key a claimed run's harness reads, a repository credential a leased run
    // checks out with, and a queued run either would be answered for.
    const PROVIDER_KEY = 'sk-ant-api03-bm9uLXJvdGF0aW5nLWRvb3ItZml4dHVyZQ';
    const REPOSITORY_TOKEN = 'synthetic-non-rotating-repository-credential';
    const secrets = deploymentSecretStore(serverEnv.db, serverEnv.wrappingKey);
    await secrets.put('anthropic', PROVIDER_KEY, 'mem_machine_1', issuedAt);
    await settingsWriter(db).setLeaf('agent.harnesses.claude-code.credential', 'deployment', 'mem_machine_1', Date.now());
    await projectRepositories(db, secrets).save('proj_1', { url: 'https://example.test/team/source', branch: 'main', revision: null, credential: { username: 'reader', token: REPOSITORY_TOKEN } }, 'mem_machine_1', issuedAt);
    sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [issuedAt]);
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context)
      VALUES ('proj_1', 'run_door', 'myco-agent', 'vault-seed', 'queued', ?, 'worker', ?, '{}')`, [issuedAt, JSON.stringify({ serverUrl: 'https://s', actor: 'mem_machine_1' })]);
    const offer = { harnesses: [offeredHarness('claude-code')], capabilities: [REPOSITORY_CHECKOUT_CAPABILITY] };
    const authority = () => ({
      credentials: sqlite.query('SELECT id FROM member_credentials ORDER BY id').all(),
      enrollments: sqlite.query('SELECT * FROM enrollment_authorities ORDER BY rowid').all(),
      linkKeys: sqlite.query('SELECT * FROM identity_link_authorities ORDER BY rowid').all(),
      grants: sqlite.query('SELECT * FROM external_grants ORDER BY rowid').all(),
      owner: sqlite.query('SELECT member_id FROM deployment_ownership').all(),
      roles: sqlite.query('SELECT id, role FROM members ORDER BY id').all(),
    });
    /** Every string an answer carries that has the shape of a member or run credential, other than the one presented. */
    const credentialsIn = (value: unknown, presented: string): string[] => typeof value === 'string' ? (MEMBER_TOKEN_PATTERN.test(value) && value !== presented ? [value] : [])
      : Array.isArray(value) ? value.flatMap((v) => credentialsIn(v, presented))
        : value !== null && typeof value === 'object' ? Object.values(value).flatMap((v) => credentialsIn(v, presented)) : [];
    for (const [route, fixture] of Object.entries(fixtures)) {
      if (route === 'POST /members/roles' || route === 'GET /members/raw-claims') sqlite.run("UPDATE deployment_ownership SET member_id='mem_machine_1' WHERE id=1");
      if (route === 'POST /members/ownership/transfer') sqlite.run("UPDATE members SET role='admin',github_id='gate-transfer' WHERE id='mem_machine_2'");
      if (route === 'POST /members/ownership') sqlite.run("UPDATE members SET github_id = 'gate-owner' WHERE id = 'mem_machine_1'");
      const nonRotating = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, issuedAt, null, NO_RUNTIME_CLAIMS, { rotates: false });
      let request = fixture.wellFormed(nonRotating.token);
      if (route === 'POST /worker/claim') request = new Request('https://s/worker/claim', { method: 'POST', headers: memberHeaders(nonRotating.token), body: JSON.stringify(offer) });
      if (route === 'POST /worker/repository') {
        // The lease a repository door answers under, taken as a worker would hold it.
        const leased = await claimNextRun(serverEnv, { principal: legacyWorker(nonRotating.tokenId, 'machine_1'), now: Date.now(), ...offer });
        expect({ route, leased: leased.claimed }).toEqual({ route, leased: true });
        request = new Request('https://s/worker/repository', { method: 'POST', headers: memberHeaders(nonRotating.token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_door' }) });
      }
      const before = authority();
      const answered = await worker.fetch(request, e);
      const text = await answered.text();
      expect({ route, authenticated: answered.status !== 401 }).toEqual({ route, authenticated: true });
      expect({ route, authority: authority() }).toEqual({ route, authority: before });
      expect({ route, providerKey: text.includes(PROVIDER_KEY), repositoryCredential: text.includes(REPOSITORY_TOKEN) }).toEqual({ route, providerKey: false, repositoryCredential: false });
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      expect({ route, credentials: credentialsIn(parsed, nonRotating.token) }).toEqual({ route, credentials: [] });
    }
    sqlite.close();
  });

  // V8 (the Worker): a call taking one argument per byte throws past about 125k arguments, where JSC (Bun) accepts it.
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

  it('never rewrites a session\'s identity columns on receipt: a second token of the same machine moves only the last receipt', async () => {
    const { env: e, db, sqlite } = sqliteEnv({ workerLogin: true });
    const first = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const second = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await jsonBody((await worker.fetch(memberPost(first.token, envelope()), e)))).toEqual({ persisted: true, projected: true });
    const before = sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get();
    expect(before).toEqual({ machine_id: 'machine_1', created_by_token_id: first.tokenId, first_received_at: expect.any(Number) });
    expect(await jsonBody((await worker.fetch(memberPost(second.token, envelope({ eventId: uuid(70), payload: { promptId: uuid(71), text: 'next', origin: 'user' } })), e)))).toEqual({ persisted: true, projected: true });
    expect(sqlite.query(`SELECT machine_id, created_by_token_id, first_received_at FROM sessions`).get()).toEqual(before);
  });

  it('binds every Env key in wrangler.toml, declares no binding Env does not name, and applies migrations from the directory the schema gates verify', () => {
    const envSource = readFileSync(join(SRC, 'platform', 'cloudflare', 'env.ts'), 'utf8');
    const block = /export interface CloudflareBindings extends OwnerBindings \{([^}]*)\}/.exec(envSource);
    expect(block).not.toBeNull();
    const keys = [...block![1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
    expect(keys.length).toBeGreaterThan(0);
    const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
    // CLOCK is optional in Env — a test env binds no clock — so it sits outside
    // the required-binding equality, like SECRET_WRAP_KEY.
    // A binding Env declares optional is bound where the Deployment has one and absent where it does not, so the
    // equality holds over what Env requires, and every binding declared here is still one Env names.
    const declaration = envSource.slice(envSource.indexOf('export interface CloudflareBindings'), envSource.indexOf('type AssertAssignable'));
    const optional = [...declaration.matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
    const bound = [...toml.matchAll(/^(?:binding|name) = "(\w+)"$/gm)].map((m) => m[1]).filter((name) => name !== 'myco-server' && name !== 'CLOCK').sort();
    expect(bound.filter((name) => !optional.includes(name))).toEqual(keys);
    expect(bound.filter((name) => !optional.includes(name) && !keys.includes(name))).toEqual([]);
    expect(bound.filter((name) => optional.includes(name))).toEqual(['RECOVERY', 'RECOVERY_BUCKET']);
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

  it('serves a signed-in account ahead of membership on exactly the routes that link it, report it and sign it out, and refuses every other session route to an account that is no member, whatever owner the environment names', async () => {
    const optional = ROUTES.filter((r) => r.auth === 'session' && r.authority === 'account').map((r) => `${r.method} ${r.path}`).sort();
    expect(optional).toEqual(['GET /auth/me', 'POST /auth/link', 'POST /auth/logout']);
    const { OWNER_ENV, ownerCookie } = await import('./helpers/owner.js');
    const outsider = '999999';
    const admitted: string[] = [];
    for (const r of ROUTES) {
      if (r.auth !== 'session' || r.authority === 'account') continue;
      const e = sqliteEnv({ workerLogin: true });
      const cookie = await ownerCookie(e.db, Date.now(), outsider);
      const res = await worker.fetch(
        new Request(`https://s${concretePath(r.path)}`, { method: r.method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }, body: r.method === 'GET' ? undefined : '{}' }),
        { ...e.env, ...OWNER_ENV, OWNER_GITHUB_ID: outsider },
      );
      if (res.status !== 401 && res.status !== 403) admitted.push(`${r.method} ${r.path} ${res.status}`);
      e.sqlite.close();
    }
    expect(admitted).toEqual([]);
  });

  it('declares on every session route which of the three authorities it admits (#1491)', () => {
    const session = ROUTES.filter((r) => r.auth === 'session');
    expect(session.length).toBeGreaterThan(0);
    for (const r of session) {
      const route = `${r.method} ${r.path}`;
      const declared = (r as { authority?: unknown }).authority;
      expect({ route, declared: (SESSION_AUTHORITIES as readonly unknown[]).includes(declared) }).toEqual({ route, declared: true });
    }
  });

  it('refuses a member who is not an admin on every admin route, before its handler, and on no other session route (#1491)', async () => {
    const { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } = await import('./helpers/owner.js');
    const now = Date.now();
    const refused: string[] = [];
    const admitted: string[] = [];
    for (const r of ROUTES) {
      if (r.auth !== 'session' || r.authority === 'account') continue;
      const path = r.path.replace('{projectId}', 'proj_1').replace('{sessionId}', 's1').replace('{promptId}', '00000000-0000-7000-8000-000000000001').replace('{planKey}', '00000000-0000-5000-8000-000000000002').replace('{runId}', 'r1').replace('{memberId}', 'mem_machine_2').replace('{grantId}', 'eg_x').replace('{id}', 'x').replace('{child}', 'prompts').replace('{key}', 'a'.repeat(64)).replace(/\{[A-Za-z]+\}/g, 'x');
      for (const who of ['member', 'admin'] as const) {
        const e = sqliteEnv({ workerLogin: true });
        seedMemberRoleAccount(e.sqlite);
        const cookie = await ownerCookie(e.db, now, who === 'member' ? MEMBER_SUB : undefined);
        const res = await worker.fetch(
          new Request(`https://s${path}`, { method: r.method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }, body: r.method === 'GET' ? undefined : '{}' }),
          { ...e.env, ...OWNER_ENV },
        );
        const body = res.status === 403 ? await res.json() as { error?: string } : null;
        const label = `${who} ${r.method} ${r.path}`;
        (body?.error === 'not_admin' ? refused : admitted).push(label);
      }
    }
    const adminRoutes = ROUTES.filter((r) => r.auth === 'session' && r.authority === 'admin').map((r) => `member ${r.method} ${r.path}`).sort();
    expect(adminRoutes.length).toBeGreaterThan(0);
    expect(refused.sort()).toEqual(adminRoutes);
    expect(admitted.filter((l) => l.startsWith('admin ')).length).toBe(ROUTES.filter((r) => r.auth === 'session' && r.authority !== 'account').length);
  });

  it('answers the Deployment settings to a member who is not an admin with every URL\'s userinfo and query stripped, and raw to an admin (#1491)', async () => {
    const { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } = await import('./helpers/owner.js');
    const e = sqliteEnv({ workerLogin: true });
    seedMemberRoleAccount(e.sqlite);
    const secretUrl = 'https://user:hunter2@embed.example/v1?api-key=sk-live';
    e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('embedding.base_url', ?, 1, 'mem_machine_1')`, [JSON.stringify(secretUrl)]);
    const read = async (sub?: string) => {
      const res = await worker.fetch(new Request('https://s/api/settings', { headers: { cookie: await ownerCookie(e.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), { ...e.env, ...OWNER_ENV });
      return ((await res.json()) as { leaves: { leaf: string; value: unknown }[] }).leaves.find((l) => l.leaf === 'embedding.base_url')?.value;
    };
    expect({ member: await read(MEMBER_SUB), admin: await read() }).toEqual({ member: 'https://embed.example/v1', admin: secretUrl });
  });

  it('bounds an admin route body before authorization and refuses a non-admin before invoking or writing', async () => {
    const { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } = await import('./helpers/owner.js');
    const e = sqliteEnv({ workerLogin: true });
    seedMemberRoleAccount(e.sqlite);
    const memberCookie = await ownerCookie(e.db, Date.now(), MEMBER_SUB);
    const before = storedRows(e.sqlite);
    let pulled = 0;
    // Nothing is pulled until something reads it; a reader would take four chunks and the end.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; if (pulled > 4) controller.close(); else controller.enqueue(new Uint8Array(64 * 1024)); },
    }, { highWaterMark: 0 });
    const res = await worker.fetch(new Request('https://s/api/backups/restore-upload', {
      method: 'POST', body, duplex: 'half', headers: { cookie: memberCookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' },
    } as RequestInit), { ...e.env, ...OWNER_ENV });
    expect({ status: res.status, pulled, body: await res.json() }).toEqual({ status: 403, pulled: 5, body: { error: 'not_admin', reason: 'this action is for an admin' } });
    expect(storedRows(e.sqlite)).toEqual(before);
    expect({ puts: e.bucket.puts, gets: e.bucket.gets, deletes: e.bucket.deletes, pending: e.deferred.pending }).toEqual({ puts: [], gets: [], deletes: [], pending: [] });

    let oversizedPulls = 0;
    const chunks = Math.floor(MAX_BODY_BYTES / (64 * 1024)) + 1;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        oversizedPulls += 1;
        if (oversizedPulls > chunks) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024));
      },
    }, { highWaterMark: 0 });
    const bounded = await worker.fetch(new Request('https://s/api/settings/agent.power', {
      method: 'PUT', body: oversized, duplex: 'half', headers: { cookie: memberCookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' },
    } as RequestInit), { ...e.env, ...OWNER_ENV });
    expect({ status: bounded.status, pulled: oversizedPulls, body: await bounded.json() })
      .toEqual({ status: 400, pulled: chunks + 1, body: { error: 'bad_request', reason: `body exceeds ${MAX_BODY_BYTES} bytes` } });
    expect(storedRows(e.sqlite)).toEqual(before);
    e.sqlite.close();
  });

  it('signs out an account whose member was removed, so it can still clear its cookie (#1491)', async () => {
    const { OWNER_ENV, ownerCookie } = await import('./helpers/owner.js');
    const e = sqliteEnv({ workerLogin: true });
    const res = await worker.fetch(new Request('https://s/auth/logout', {
      method: 'POST', headers: { cookie: await ownerCookie(e.db, Date.now(), '999999'), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' },
    }), { ...e.env, ...OWNER_ENV });
    expect({ status: res.status, clears: /Max-Age=0/i.test(res.headers.get('set-cookie') ?? '') }).toEqual({ status: 204, clears: true });
  });

  it('never lets the hosted shell be framed', () => {
    const headers = readFileSync(join(WORKER, 'ui', 'public', '_headers'), 'utf8');
    expect(headers).toMatch(/^\/\*\n  X-Frame-Options: DENY\n  Content-Security-Policy: frame-ancestors 'none'\n/);
  });

  it('answers every session route without disclosing the protocol number', async () => {
    const owner = ROUTES.filter((r) => r.auth === 'session');
    expect(owner.length).toBeGreaterThan(0);
    const { OWNER_ENV, ownerCookie } = await import('./helpers/owner.js');
    for (const r of owner) {
      const path = r.path.replace('{projectId}', 'proj_1').replace('{sessionId}', 's1').replace('{promptId}', '00000000-0000-7000-8000-000000000001').replace('{planKey}', '00000000-0000-5000-8000-000000000002').replace('{runId}', 'r1').replace('{memberId}', 'mem_machine_2').replace('{grantId}', 'eg_x').replace('{id}', 'x').replace('{child}', 'prompts').replace('{key}', 'a'.repeat(64));
      const e = sqliteEnv({ workerLogin: true });
      const cookie = await ownerCookie(e.db);
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

  it('keeps every live and retired route in one reviewed ledger', () => {
    expect([
      ...ROUTES.map(r => `${r.auth === 'session' ? `session:${r.authority}` : r.auth} ${r.method} ${r.path}`),
      ...RETIRED_ROUTES.map(r => `retired ${r.method} ${r.path}`),
    ].sort()).toEqual(routeLedger);
  });

  it('names every binding a capability stands on, and reports that capability absent when the binding is missing', () => {
    const bound = sqliteEnv().env;
    const capabilities = serverEnvFromBindings(bound as never).platform.capabilities();
    const served = capabilities.filter((c) => c.capability !== 'harness-runtime');
    expect(served.map((c) => ({ capability: c.capability, present: c.present, names: c.operatorNames.length > 0 })))
      .toEqual(served.map((c) => ({ capability: c.capability, present: true, names: true })));
    for (const name of served.flatMap((c) => c.operatorNames)) {
      const missing = serverEnvFromBindings({ ...bound, [name]: undefined } as never).platform.capabilities().filter((c) => !c.present).flatMap((c) => c.operatorNames);
      expect({ name, named: missing.includes(name) }).toEqual({ name, named: true });
    }
  });

  it('authenticates a member route by its bearer alone: a signed-in admin\'s cookie opens none of them', async () => {
    const { OWNER_ENV, ownerCookie } = await import('./helpers/owner.js');
    const e = sqliteEnv({ workerLogin: true });
    const cookie = await ownerCookie(e.db);
    const opened: string[] = [];
    for (const r of ROUTES.filter((x) => x.auth === 'member')) {
      const res = await worker.fetch(new Request(`https://s${concretePath(r.path)}`, {
        method: r.method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', [PROJECT_HEADER]: 'proj_1', ...PROTOCOL }, body: '{}',
      }), { ...e.env, ...OWNER_ENV });
      if (res.status !== 401) opened.push(`${r.method} ${r.path} ${res.status}`);
    }
    expect(opened).toEqual([]);
    expect({ events: count(e.sqlite, 'events'), blobs: count(e.sqlite, 'blobs') }).toEqual({ events: 0, blobs: 0 });
    e.sqlite.close();
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
    expect(Object.keys(runtime).filter((pkg) => pkg !== 'sqlite-vec' && ![...(imported.get(pkg) ?? [])].some((f) => shared.has(f)))).toEqual([]);
    expect([...(imported.get('sqlite-vec') ?? [])]).toEqual([join(SRC, 'platform', 'bun', 'vectors.ts')]);
    expect(runtime).toEqual({ '@modelcontextprotocol/server': '2.4.0', '@goondocks/myco-shared': '^0.2.0', '@stablelib/sha256': '2.0.1', semver: '^7.8.6', 'sqlite-vec': '^0.1.9' });
  });

  it('leaves owner routes ingest-neutral', async () => {
    const e = sqliteEnv({ workerLogin: true });
    const before = count(e.sqlite, 'events');
    const credentials = (sqlite: Database) => sqlite.query('SELECT * FROM member_credentials ORDER BY id').all();
    const credentialsBefore = credentials(e.sqlite);
    const res = await worker.fetch(
      new Request('https://s/api/projects', { headers: { cookie: await ownerCookie2(e.db), 'cf-connecting-ip': '1.2.3.4' } }),
      { ...e.env, ...OWNER_ENV2 }
    );
    expect(res.status).toBe(200);
    expect(count(e.sqlite, 'events')).toBe(before);
    expect(credentials(e.sqlite)).toEqual(credentialsBefore);
  });

});
