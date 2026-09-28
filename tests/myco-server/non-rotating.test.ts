/**
 * A credential its issuer minted not to rotate (#1420).
 *
 * An orchestrator hands one token to every sandbox it starts through
 * `MYCO_MEMBER_TOKEN`, so the issuer marks it non-rotating at mint and the
 * refresh route refuses it before it authenticates a rotation: a holder of a
 * copy, live or lapsed, can mint no successor and so can never fork the
 * lineage, and no holder can revoke it under the others. It lives out its TTL
 * or a Stop. A credential that rotates — every credential a join mints —
 * rotates and is replay-revoked exactly as before.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import {
  issueMemberToken, LINEAGE_REPLAY_REVOKER, MEMBER_TOKEN_TTL_MS, NO_RUNTIME_CLAIMS, refreshMemberToken, activateSuccessor,
} from '@myco-server-worker/auth/tokens.js';
import { NON_ROTATING, NON_ROTATING_AUTHORITY } from '@myco-server-worker/pipeline.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memberHeaders } from './helpers/fixtures.js';
import { OWNER_ENV } from './helpers/owner.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { TokenRevokedError } from '@myco-server-worker/telemetry.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';
import { jsonBody } from '../helpers/json-body.js';

const MEMBER = { memberId: 'mem_machine_1', machineId: 'machine_1' };
const DAY_MS = 24 * 60 * 60 * 1000;

const refreshRequest = (token: string, ip = '1.2.3.4') => new Request('https://s/tokens/refresh', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip, 'content-type': 'application/json', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: '{}',
});
const post = (token: string, n: number, ip = '1.2.3.4') => new Request('https://s/events', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip, [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: JSON.stringify(envelope({ eventId: uuid(n) })),
});

type Env = ReturnType<typeof sqliteEnv>;
/** Every credential row, in a form two snapshots compare on. */
const rows = (e: Env) => e.sqlite.query(`SELECT id, predecessor_id, lineage_root, revoked_at, revoked_by, first_used_at, expires_at, rotates FROM member_credentials ORDER BY id`).all();
const liveRows = (e: Env) => e.sqlite.query(`SELECT id FROM member_credentials WHERE revoked_at IS NULL`).all() as { id: string }[];

/** A non-rotating credential issued `ageMs` ago. */
async function envCredential(ageMs: number) {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.db, MEMBER, Date.now() - ageMs, null, NO_RUNTIME_CLAIMS, { rotates: false });
  return { e, issued };
}

describe('a credential minted not to rotate', () => {
  it('is recorded non-rotating by its issuer; a default mint, a join and a successor rotate', async () => {
    const e = sqliteEnv();
    const fixed = await issueMemberToken(e.db, MEMBER, Date.now(), null, NO_RUNTIME_CLAIMS, { rotates: false });
    const rotating = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const rotatesOf = (id: string) => (e.sqlite.query(`SELECT rotates FROM member_credentials WHERE id = ?`).get(id) as { rotates: number }).rotates;
    expect({ fixed: rotatesOf(fixed.tokenId), rotating: rotatesOf(rotating.tokenId) }).toEqual({ fixed: 0, rotating: 1 });
  });

  it('inside its refresh window: /tokens/refresh answers `non_rotating`, mints nothing and changes no row', async () => {
    const { e, issued } = await envCredential(6 * DAY_MS);
    const before = rows(e);

    const res = await worker.fetch(refreshRequest(issued.token), e.env);

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ refreshed: false, code: 'non_rotating', reason: NON_ROTATING });
    expect(rows(e)).toEqual(before);
    expect(liveRows(e)).toEqual([{ id: issued.tokenId }]);
  });

  it('expired: the one route that admits a lapsed token still refuses it, mints nothing and changes no row', async () => {
    const { e, issued } = await envCredential(MEMBER_TOKEN_TTL_MS + DAY_MS);
    const before = rows(e);

    const refused = await worker.fetch(refreshRequest(issued.token), e.env);
    expect(await jsonBody(refused)).toMatchObject({ refreshed: false, code: 'non_rotating' });
    // Past its TTL it writes nothing anywhere else either.
    expect((await worker.fetch(post(issued.token, 1), e.env)).status).toBe(401);

    expect(rows(e)).toEqual(before);
  });

  it('copied: a second holder cannot fork it — every holder is refused rotation, the original stays the only live row, and both keep capturing until the TTL', async () => {
    const { e, issued } = await envCredential(6 * DAY_MS);
    const before = rows(e);

    // The thief asks first, the owner after; neither rotation lands.
    for (const ip of ['9.9.9.9', '1.2.3.4', '9.9.9.9']) {
      const res = await worker.fetch(refreshRequest(issued.token, ip), e.env);
      expect(await jsonBody(res)).toMatchObject({ refreshed: false, code: 'non_rotating' });
    }
    expect(rows(e)).toEqual(before);
    expect(liveRows(e)).toEqual([{ id: issued.tokenId }]);

    // A copy is not detectable as a replay — there is no successor to be superseded by — so nothing is revoked.
    const owner = await worker.fetch(post(issued.token, 2), e.env);
    const thief = await worker.fetch(post(issued.token, 3, '9.9.9.9'), e.env);
    expect([(await owner.json() as Record<string, unknown>).persisted, (await thief.json() as Record<string, unknown>).persisted]).toEqual([true, true]);
    expect(e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials WHERE revoked_by = ?`).get(LINEAGE_REPLAY_REVOKER)).toEqual({ c: 0 });
  });

  it('a Stop still ends it: once revoked it answers 401 on the refresh route and mints nothing', async () => {
    const { e, issued } = await envCredential(6 * DAY_MS);
    e.sqlite.query(`UPDATE member_credentials SET revoked_at = ?, revoked_by = 'mem_admin' WHERE id = ?`).run(Date.now(), issued.tokenId);
    const before = rows(e);

    expect((await worker.fetch(refreshRequest(issued.token), e.env)).status).toBe(401);
    expect(rows(e)).toEqual(before);
  });

  it('cannot gain a successor from storage either: the insert admits a successor only of a row that rotates', async () => {
    const { e, issued } = await envCredential(6 * DAY_MS);
    const before = rows(e);
    const subject = {
      memberId: MEMBER.memberId, tokenId: issued.tokenId, machineId: MEMBER.machineId, expiresAt: issued.expiresAt,
      lineageRoot: issued.tokenId, lineageStartedAt: issued.expiresAt - MEMBER_TOKEN_TTL_MS, runtime: NO_RUNTIME_CLAIMS,
    };

    await expect(refreshMemberToken(e.db, subject, Date.now())).rejects.toBeInstanceOf(TokenRevokedError);
    expect(rows(e)).toEqual(before);
  });
});

describe('a credential that rotates, beside it', () => {
  it('still rotates on the refresh route, and its successor rotates too', async () => {
    const e = sqliteEnv();
    const root = await issueMemberToken(e.db, MEMBER, Date.now() - 6 * DAY_MS);
    const res = await worker.fetch(refreshRequest(root.token), e.env);
    const body = await res.json() as { refreshed: boolean; tokenId: string };
    expect(body.refreshed).toBe(true);
    expect(e.sqlite.query(`SELECT predecessor_id, rotates FROM member_credentials WHERE id = ?`).get(body.tokenId)).toEqual({ predecessor_id: root.tokenId, rotates: 1 });
  });

  it('is still replay-revoked when a superseded token of it asks to rotate', async () => {
    const e = sqliteEnv();
    const now = Date.now();
    const root = await issueMemberToken(e.db, MEMBER, now - 6 * DAY_MS);
    const successor = await refreshMemberToken(e.db, {
      memberId: MEMBER.memberId, tokenId: root.tokenId, machineId: MEMBER.machineId, expiresAt: root.expiresAt,
      lineageRoot: root.tokenId, lineageStartedAt: now - 6 * DAY_MS, runtime: NO_RUNTIME_CLAIMS,
    }, now);
    if (!successor.refreshed) throw new Error('fixture: refresh refused');
    await activateSuccessor(e.db, { tokenId: successor.tokenId, predecessorId: root.tokenId }, now);

    const res = await worker.fetch(refreshRequest(root.token), e.env);

    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ error: 'unauthorized', code: 'lineage_replayed' });
    expect(liveRows(e)).toEqual([]);
  });
});

describe('every route that mints an authority able to outlive the credential (#1420)', () => {
  const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));
  const linkRequest = (token: string) => new Request('https://s/members/link-github', { method: 'POST', headers: memberHeaders(token), body: '{}' });
  const linkKeys = (e: Env) => (e.sqlite.query(`SELECT COUNT(*) c FROM identity_link_authorities`).get() as { c: number }).c;

  it('is declared in the route table: the refresh and the GitHub link, and no other member route', () => {
    const declared = ROUTES.filter((r) => r.auth === 'member' && 'mintsAuthority' in r && r.mintsAuthority === true).map((r) => `${r.method} ${r.path}`);
    expect(declared).toEqual(['POST /tokens/refresh', 'POST /members/link-github']);
  });

  it('is the only member route that reaches an authority minter: every other caller is an owner route, the join, or a run credential minted not to rotate', () => {
    // A minter is anything that answers with a new token or key. Each file that calls one is named here with the door
    // that reaches it, so a member route that starts minting fails this gate until it is declared `mintsAuthority`.
    const MINTERS = /\b(issueIdentityLinkAuthority|issueEnrollmentAuthority|issueExternalGrant|rotateExternalGrant|mintInsert|issueMemberToken)\(/;
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (statSync(file).isDirectory()) walk(file);
        else if (file.endsWith('.ts') && readFileSync(file, 'utf8').split('\n').some((line) => MINTERS.test(line) && !/^\s*(export\s+)?(async\s+)?function\b/.test(line))) callers.push(relative(SRC, file));
      }
    };
    walk(SRC);
    expect(callers.sort()).toEqual([
      'api/access.ts', // POST /api/enrollment — owner session
      'api/grants.ts', // grant mint and rotate — owner session
      'auth/join.ts', // POST /members/join — an enrollment key, no member credential
      'auth/members.ts', // POST /members/link-github — mintsAuthority
      'auth/tokens.ts', // the insert itself, and the refresh — mintsAuthority
      'core/harness.ts', // run credentials, minted not to rotate
    ].sort());
    const harness = readFileSync(join(SRC, 'core', 'harness.ts'), 'utf8').split('\n').filter((line) => /issueMemberToken\(/.test(line) && !/^import/.test(line));
    expect(harness.length).toBe(2);
    for (const line of harness) expect(line).toContain('{ rotates: false }');
  });

  it('refuses a GitHub link key to a credential that does not rotate, live, and mints no key', async () => {
    const { e, issued } = await envCredential(DAY_MS);
    const res = await worker.fetch(linkRequest(issued.token), { ...e.env, ...OWNER_ENV });
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'non_rotating', reason: NON_ROTATING_AUTHORITY });
    expect(linkKeys(e)).toBe(0);
  });

  it('still answers a GitHub link key to a credential that rotates', async () => {
    const e = sqliteEnv();
    const rotating = await issueMemberToken(e.db, MEMBER, Date.now());
    const res = await worker.fetch(linkRequest(rotating.token), { ...e.env, ...OWNER_ENV });
    expect(await jsonBody(res)).toMatchObject({ persisted: true });
    expect(linkKeys(e)).toBe(1);
  });
});
