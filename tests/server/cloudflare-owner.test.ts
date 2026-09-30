/**
 * The hosted Deployment's first administrator, set up from the operator's machine (#1500).
 *
 * `setup-owner --target cloudflare` runs the same first-owner setup the local target runs, over the Deployment's
 * database through the D1 API. Here the D1 API is served from a migrated SQLite database, so the rows a setup writes are
 * the rows the Deployment's own sign-in then reads, and wrangler and the sign-in route are scripted.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { previewIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { FIRST_OWNER_HAS_MEMBERS, FIRST_OWNER_LINKED, setupFirstOwner } from '@myco-server-worker/core/first-owner.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { CLOUDFLARE_SCHEMA_MISMATCH, setupCloudflareOwner } from '@myco/server/cloudflare-owner.js';
import { d1OperatorStore } from '@myco/server/d1-operator-store.js';
import { writeDeploymentRecord, WranglerAbsent, type CloudflareFetch } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { BUNDLED_WORKER_WRANGLER } from '@myco/worker-bundle.generated.js';

const ACCOUNT = 'a'.repeat(32);
const DATABASE = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'https://myco.example.com';
const QUERY = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

/** A fresh Deployment's database: every migration applied, no member. */
function deploymentDatabase(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  return sqlite;
}

interface D1ApiOptions {
  /** Statements that wait until `holdFor` of them have arrived, then run in arrival order. */
  hold?: { match: (sql: string) => boolean; holdFor: number };
  /** Runs against the database just before a statement it matches runs: another machine's write landing in between. */
  before?: { match: (sql: string) => boolean; run: (sqlite: Database) => void };
  /** A statement it matches runs, and its first answer is lost: the provider answers 503 and the caller sends it again. */
  loseAnswerOnce?: (sql: string) => boolean;
  /** Answers every statement with no changed-row count. */
  omitChanges?: boolean;
}

/**
 * The D1 query API over `sqlite`: one statement per request, with its rows and changed-row count, as the provider
 * answers, shaped by `options`.
 */
function d1Api(sqlite: Database, options: D1ApiOptions = {}) {
  const { hold, before } = options;
  const statements: string[] = [];
  const lost = new Set<string>();
  const waiting: Array<() => void> = [];
  const fetch: CloudflareFetch = async (url, init) => {
    expect(url).toBe(QUERY);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer operator');
    const { sql, params = [] } = JSON.parse(String(init.body)) as { sql: string; params?: Array<string | number | null> };
    statements.push(sql);
    await Promise.resolve();
    if (hold?.match(sql)) {
      await new Promise<void>((release) => {
        waiting.push(release);
        if (waiting.length === hold.holdFor) for (const next of waiting.splice(0)) next();
      });
    }
    if (before?.match(sql)) before.run(sqlite);
    const statement = sqlite.prepare(sql);
    const reads = statement.columnNames.length > 0;
    const results = reads ? statement.all(...params) : [];
    const changes = reads ? 0 : statement.run(...params).changes;
    if (options.loseAnswerOnce?.(sql) && !lost.has(sql)) {
      lost.add(sql);
      return Response.json({ success: false, errors: [{ code: 7500, message: 'upstream timed out' }] }, { status: 503 });
    }
    return Response.json({ success: true, errors: [], messages: [], result: [{ success: true, results, ...(options.omitChanges ? {} : { meta: { changes } }) }] });
  };
  return { fetch, statements };
}

/** Wrangler signed in, handing out the operator's token. */
const wrangler = (installed = true): { runner: CommandRunner; ran: string[] } => {
  const ran: string[] = [];
  return {
    ran,
    runner: {
      async run(_command, args) {
        const flat = args.join(' ');
        ran.push(flat);
        if (!installed) return { code: 1, stdout: '', stderr: 'npx: command not found: wrangler' };
        if (flat.includes('--version')) return { code: 0, stdout: ` wrangler ${BUNDLED_WORKER_WRANGLER}`, stderr: '' };
        if (flat.includes('auth token --json')) return { code: 0, stdout: '{"type":"oauth","token":"operator"}', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  };
};

/** The Deployment's sign-in route: GitHub's authorize page with a client id and its own callback, one with no client id, or not yet. */
const signIn = (configured: boolean | 'no-client-id'): typeof fetch => (async () => (configured === false
  ? new Response('sign-in is not configured', { status: 503 })
  : new Response(null, { status: 302, headers: { location: `https://github.com/login/oauth/authorize?${configured === 'no-client-id' ? '' : 'client_id=Iv1.test&'}redirect_uri=${encodeURIComponent(`${ORIGIN}/auth/callback`)}` } }))) as unknown as typeof fetch;

function hosted(options: { signedIn?: boolean | 'no-client-id'; installed?: boolean; record?: boolean | 'no-database'; api?: D1ApiOptions } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'myco-cf-owner-'));
  homes.push(home);
  if (options.record !== false) {
    writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', bucketName: 'myco-server-blobs',
      versionId: 'v1', deployedAt: 'then', ...(options.record === 'no-database' ? {} : { databaseId: DATABASE }), storeId: 'f'.repeat(32), url: ORIGIN }, home);
  }
  const sqlite = deploymentDatabase();
  const api = d1Api(sqlite, options.api);
  const tool = wrangler(options.installed ?? true);
  const setup = () => setupCloudflareOwner({ accountId: ACCOUNT, mycoHome: home, runner: tool.runner, fetch: api.fetch, signInFetch: signIn(options.signedIn ?? true) });
  return { sqlite, api, tool, setup, db: sqliteRelationalStore(sqlite) };
}

const count = (sqlite: Database, table: string): number => (sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('setup-owner --target cloudflare', () => {
  it('records the administrator and mints the link its first GitHub sign-in confirms, over the D1 API alone', async () => {
    const { sqlite, setup, db, api } = hosted();
    const first = await setup();
    expect(first.url.startsWith(`${ORIGIN}/link#`)).toBe(true);
    expect(sqlite.query('SELECT id, role, github_id FROM members').all()).toEqual([{ id: first.memberId, role: 'admin', github_id: null }]);
    // A retry before the link is used takes the same administrator and replaces its link.
    const second = await setup();
    expect(second.memberId).toBe(first.memberId);
    expect(await previewIdentityLinkAuthority(db, new URL(first.url).hash.slice(1), Date.now())).toEqual({ ok: false, reason: 'denied' });
    expect(await spendIdentityLinkAuthority(db, new URL(second.url).hash.slice(1), '583231', Date.now()))
      .toMatchObject({ ok: true, member: { id: first.memberId, role: 'admin' } });
    // Linked: the Deployment has its administrator, and a third run changes nothing.
    await expect(setup()).rejects.toThrow(FIRST_OWNER_HAS_MEMBERS);
    expect(count(sqlite, 'members')).toBe(1);
    // Only the key's digest reached the Deployment.
    expect(api.statements.join('\n')).not.toContain(new URL(second.url).hash.slice(1));
  });

  it('refuses a Deployment that already has a member, writing nothing', async () => {
    const { sqlite, setup } = hosted();
    sqlite.query("INSERT INTO members (id, label, created_at, role) VALUES ('mem_existing', 'Existing', 1, 'member')").run();
    await expect(setup()).rejects.toThrow(FIRST_OWNER_HAS_MEMBERS);
    expect(count(sqlite, 'identity_link_authorities')).toBe(0);
    expect(sqlite.query("SELECT COUNT(*) AS n FROM schema_meta WHERE key = 'first_member_setup'").get()).toEqual({ n: 0 });
  });

  it('refuses a Deployment at another schema, naming the update that fixes it', async () => {
    const { sqlite, setup } = hosted();
    sqlite.query("UPDATE schema_meta SET value = '1' WHERE key = 'version'").run();
    await expect(setup()).rejects.toThrow(CLOUDFLARE_SCHEMA_MISMATCH);
    expect(count(sqlite, 'members')).toBe(0);
  });

  it('refuses before any database request where sign-in is not set up, naming the command that sets it up', async () => {
    const { setup, api, sqlite } = hosted({ signedIn: false });
    await expect(setup()).rejects.toThrow(`myco server github-app --target cloudflare --url ${ORIGIN}`);
    expect(api.statements).toEqual([]);
    expect(count(sqlite, 'members')).toBe(0);
  });

  it('refuses with no wrangler, by name, before anything else runs', async () => {
    const { setup, api, tool } = hosted({ installed: false });
    await expect(setup()).rejects.toThrow(WranglerAbsent);
    expect(tool.ran).toEqual(['--no-install wrangler --version']);
    expect(api.statements).toEqual([]);
  });

  it('refuses where this machine holds no Deployment record, or one for another account, before anything runs', async () => {
    const { setup, tool } = hosted({ record: false });
    await expect(setup()).rejects.toThrow('myco server create --target cloudflare');
    const other = hosted();
    await expect(setupCloudflareOwner({ accountId: 'b'.repeat(32), mycoHome: homes.at(-1)!, runner: other.tool.runner, fetch: other.api.fetch, signInFetch: signIn(true) }))
      .rejects.toThrow('this account does not match the Cloudflare Deployment record');
    expect([...tool.ran, ...other.tool.ran, ...other.api.statements]).toEqual([]);
  });

  it('GATE: two setups racing from two machines make one administrator; the one that loses writes nothing', async () => {
    // Both have read an empty Deployment and send their claim together, before either writes its member.
    const sqlite = deploymentDatabase();
    const api = d1Api(sqlite, { hold: { match: (sql) => sql.startsWith('INSERT INTO schema_meta'), holdFor: 2 } });
    const store = () => d1OperatorStore({ accountId: ACCOUNT, databaseId: DATABASE, fetch: api.fetch,
      login: { current: async () => new Headers({ Authorization: 'Bearer operator' }), headers: async () => new Headers({ Authorization: 'Bearer operator' }), refused: () => {} } });
    const settled = await Promise.allSettled([setupFirstOwner(store(), Date.now(), 'schema'), setupFirstOwner(store(), Date.now(), 'schema')]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String((settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason)).toContain(FIRST_OWNER_HAS_MEMBERS);
    expect(count(sqlite, 'members')).toBe(1);
    expect(count(sqlite, 'identity_link_authorities')).toBe(1);
  });

  it('runs no batch: the operator store refuses one', async () => {
    const { api } = hosted();
    const store = d1OperatorStore({ accountId: ACCOUNT, databaseId: DATABASE, fetch: api.fetch,
      login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} } });
    await expect(store.batch([])).rejects.toThrow('runs no batch');
  });

  const operatorStore = (api: ReturnType<typeof d1Api>) => d1OperatorStore({ accountId: ACCOUNT, databaseId: DATABASE, fetch: api.fetch, sleep: async () => {},
    login: { current: async () => new Headers({ Authorization: 'Bearer operator' }), headers: async () => new Headers({ Authorization: 'Bearer operator' }), refused: () => {} } });
  const receipt = (sqlite: Database) => (sqlite.query("SELECT value FROM schema_meta WHERE key = 'first_member_setup'").get() as { value: string } | null)?.value ?? null;

  it('takes the member an earlier setup claimed but stopped before writing, and makes no other', async () => {
    const { sqlite, setup } = hosted();
    sqlite.query("INSERT INTO schema_meta (key, value) VALUES ('first_member_setup', 'mem_claimed-earlier')").run();
    const done = await setup();
    expect(done.memberId).toBe('mem_claimed-earlier');
    expect(sqlite.query('SELECT id, role FROM members').all()).toEqual([{ id: 'mem_claimed-earlier', role: 'admin' }]);
  });

  it('refuses where the earlier setup\'s administrator is revoked, minting nothing', async () => {
    const { sqlite, setup } = hosted();
    sqlite.query("INSERT INTO schema_meta (key, value) VALUES ('first_member_setup', 'mem_revoked')").run();
    sqlite.query("INSERT INTO members (id, label, created_at, role, revoked_at) VALUES ('mem_revoked', 'Deployment administrator', 1, 'admin', 2)").run();
    await expect(setup()).rejects.toThrow(FIRST_OWNER_HAS_MEMBERS);
    expect(count(sqlite, 'identity_link_authorities')).toBe(0);
  });

  it('refuses to mint where an administrator linked an account between the read and the mint', async () => {
    const { sqlite, setup } = hosted({ api: { before: {
      match: (sql) => sql.startsWith('INSERT INTO identity_link_authorities'),
      run: (db) => { db.query("INSERT INTO members (id, label, created_at, role, github_id) VALUES ('mem_linked_meanwhile', 'Other', 1, 'admin', '777')").run(); },
    } } });
    await expect(setup()).rejects.toThrow(FIRST_OWNER_LINKED);
    expect(count(sqlite, 'identity_link_authorities')).toBe(0);
  });

  it('claims nothing where a member arrived between the read and the claim', async () => {
    const { sqlite, setup } = hosted({ api: { before: {
      match: (sql) => sql.startsWith('INSERT INTO schema_meta'),
      run: (db) => { db.query("INSERT INTO members (id, label, created_at, role) VALUES ('mem_arrived', 'Arrived', 1, 'member')").run(); },
    } } });
    await expect(setup()).rejects.toThrow(FIRST_OWNER_HAS_MEMBERS);
    expect(receipt(sqlite)).toBeNull();
    expect(count(sqlite, 'members')).toBe(1);
  });

  it('continues a claim whose answer went missing and was sent again', async () => {
    const sqlite = deploymentDatabase();
    const api = d1Api(sqlite, { loseAnswerOnce: (sql) => sql.startsWith('INSERT INTO schema_meta') });
    const done = await setupFirstOwner(operatorStore(api), Date.now(), 'schema');
    expect(receipt(sqlite)).toBe(done.memberId);
    expect(api.statements.filter((sql) => sql.startsWith('INSERT INTO schema_meta'))).toHaveLength(2);
    expect(sqlite.query('SELECT id FROM members').all()).toEqual([{ id: done.memberId }]);
  });

  it('reads an answer with no changed-row count as no row changed', async () => {
    const sqlite = deploymentDatabase();
    const store = operatorStore(d1Api(sqlite, { omitChanges: true }));
    expect((await store.prepare("UPDATE schema_meta SET value = value WHERE key = 'version'").run()).meta.changes).toBe(0);
  });

  it('refuses a record that names no database, and sign-in that names no client id, before any database request', async () => {
    const noDatabase = hosted({ record: 'no-database' });
    await expect(noDatabase.setup()).rejects.toThrow('names no database');
    const noClient = hosted({ signedIn: 'no-client-id' });
    await expect(noClient.setup()).rejects.toThrow('names no client id');
    expect([...noDatabase.api.statements, ...noClient.api.statements]).toEqual([]);
  });
});
