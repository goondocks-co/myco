import ts from 'typescript-v6';
import { sourceProgram } from '../helpers/source-program.js';
import { runningEnv as sqliteEnv } from './helpers/running-env.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { offeredHarness } from './helpers/offered-harness.js';
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
import { readFileSync } from 'node:fs';
import { sourceCalls } from './helpers/source-calls.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memberHeaders, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV } from './helpers/owner.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { TokenRevokedError } from '@myco-server-worker/telemetry.js';
import { envelope, uuid } from './helpers/fixtures.js';
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
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  const issued = await issueMemberToken(e.db, MEMBER, Date.now() - ageMs, null, NO_RUNTIME_CLAIMS, { rotates: false });
  return { e, issued };
}

describe('a credential minted not to rotate', () => {
  it('is recorded non-rotating by its issuer; a default mint, a join and a successor rotate', async () => {
    const e = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(e.sqlite);
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
    const e = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(e.sqlite);
    const root = await issueMemberToken(e.db, MEMBER, Date.now() - 6 * DAY_MS);
    const res = await worker.fetch(refreshRequest(root.token), e.env);
    const body = await res.json() as { refreshed: boolean; tokenId: string };
    expect(body.refreshed).toBe(true);
    expect(e.sqlite.query(`SELECT predecessor_id, rotates FROM member_credentials WHERE id = ?`).get(body.tokenId)).toEqual({ predecessor_id: root.tokenId, rotates: 1 });
  });

  it('is still replay-revoked when a superseded token of it asks to rotate', async () => {
    const e = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(e.sqlite);
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

  it('is declared in the route table: the refresh, the worker\'s claim and repository, and the GitHub link, and no other member route', () => {
    const declared = ROUTES.filter((r) => r.auth === 'member' && 'mintsAuthority' in r && r.mintsAuthority === true).map((r) => `${r.method} ${r.path}`);
    expect(declared).toEqual(['POST /tokens/refresh', 'POST /worker/claim', 'POST /worker/repository', 'POST /members/link-github', 'POST /members/ownership', 'POST /members/ownership/transfer', 'POST /members/roles']);
  });

  it('requires authority admission on every member route that reaches a minter or secret opener', () => {
    const graph = sourceProgram([join(SRC, 'routes.ts')]);
    const source = graph.program.getSourceFile(join(SRC, 'routes.ts'))!;
    const authorityWrites = new Map<ts.Declaration, boolean>();
    const writesAuthority = (target: ts.Declaration): boolean => {
      if (authorityWrites.has(target)) return authorityWrites.get(target)!;
      let found = false;
      const visit = (node: ts.Node): void => {
        const text = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node)
          ? node.head.text + node.templateSpans.map(span => span.literal.text).join('') : '';
        if (/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO)\s+(?:member_credentials|enrollment_authorities|identity_link_authorities|external_grants)\b|\bUPDATE\s+(?:deployment_ownership\s+SET\s+member_id|members\s+SET\s+role)\b/i.test(text)) found = true;
        ts.forEachChild(node, visit);
      };
      visit(target);
      authorityWrites.set(target, found);
      return found;
    };
    const terminal = (_call: ts.CallExpression, target: ts.Declaration | undefined): boolean => {
      if (!target) return false;
      const name = 'name' in target ? (target.name as ts.Node | undefined)?.getText() : undefined;
      return writesAuthority(target)
        || name === 'get' && ts.isInterfaceDeclaration(target.parent) && target.parent.name.text === 'SecretStore'
        || name === 'access' && target.getSourceFile().fileName.endsWith('/core/repositories.ts');
    };
    const doors: string[] = [], members: string[] = [];
    const stringOf = (node: ts.Node | undefined): string | undefined => {
      if (!node) return undefined;
      if (ts.isStringLiteralLike(node)) return node.text;
      const target = graph.declaration(node);
      return target && ts.isVariableDeclaration(target) ? stringOf(target.initializer) : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const fields = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : p.name.getText(source), p.initializer]));
        if (stringOf(fields.get('auth')) === 'member') {
          const path = stringOf(fields.get('path'));
          const route = ROUTES.find(route => route.path === path && route.method === stringOf(fields.get('method')));
          expect(route, fields.get('path')?.getText(source)).toBeDefined();
          members.push(`${route!.method} ${path}`);
          if (route!.authorization.subjects.includes('member')) {
            const handlers = [...fields.values()].filter(value => graph.checker.getTypeAtLocation(value).getCallSignatures().length > 0);
            expect(handlers.length).toBeGreaterThan(0);
            const reaches = handlers.some(handler => {
              const target = graph.declaration(handler);
              expect(target, handler.getText(source)).toBeDefined();
              return graph.reaches(target!, terminal);
            });
            if (reaches) {
              doors.push(path!);
              expect({ path, guarded: fields.get('mintsAuthority')?.kind === ts.SyntaxKind.TrueKeyword }).toEqual({ path, guarded: true });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(members.sort()).toEqual(ROUTES.filter(route => route.auth === 'member').map(route => `${route.method} ${route.path}`).sort());
    expect(doors.sort()).toEqual(ROUTES.filter(route => route.auth === 'member' && 'mintsAuthority' in route && route.mintsAuthority).map(route => route.path).sort());
  });

  it('refuses every authority door before its handler for a non-rotating credential', async () => {
    const { e, issued } = await envCredential(DAY_MS);
    try {
      const doors = ROUTES.filter(route => route.auth === 'member' && 'mintsAuthority' in route && route.mintsAuthority);
      expect(doors.length).toBeGreaterThan(0);
      for (const route of doors) {
        const response = await worker.fetch(new Request('https://s' + route.path, {
          method: route.method, headers: memberHeaders(issued.token), body: '{}',
        }), e.env);
        expect(await jsonBody(response), route.path).toMatchObject({ code: 'non_rotating' });
      }
    } finally { e.sqlite.close(); }
  });

  it('refuses a GitHub link key to a credential that does not rotate, live, and mints no key, on a Deployment with no linked admin', async () => {
    const { e, issued } = await envCredential(DAY_MS);
    e.sqlite.query(`UPDATE members SET github_id = NULL`).run();
    const res = await worker.fetch(linkRequest(issued.token), { ...e.env, ...OWNER_ENV });
    expect(await jsonBody(res)).toEqual({ persisted: false, code: 'non_rotating', reason: NON_ROTATING_AUTHORITY });
    expect(linkKeys(e)).toBe(0);
  });

  it('still answers a GitHub link key to a credential that rotates, on a Deployment with no linked admin', async () => {
    const e = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(e.sqlite);
    e.sqlite.query(`UPDATE members SET github_id = NULL`).run();
    const rotating = await issueMemberToken(e.db, MEMBER, Date.now());
    const res = await worker.fetch(linkRequest(rotating.token), { ...e.env, ...OWNER_ENV });
    expect(await jsonBody(res)).toMatchObject({ persisted: true });
    expect(linkKeys(e)).toBe(1);
  });
});

describe('a worker claim from a credential minted not to rotate (#1420)', () => {
  const NOW = Date.now();
  const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const API_KEY = 'sk-ant-TEST-PROVIDER-KEY-0420';
  const claimRequest = (token: string) => new Request('https://s/worker/claim', {
    method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ harnesses: [offeredHarness('claude-code')] }),
  });

  /** An administrator's credential, rotating or not, a queued run a worker can take, and the provider key its harness would read. */
  async function queued(rotates: boolean) {
    const e = sqliteEnv({ workerLogin: true });
    turnOnGatedCapabilities(e.sqlite);
    const bindings = { ...e.env, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } };
    const env = serverEnvFromBindings(bindings as never);
    await deploymentSecretStore(env.db, env.wrappingKey).put('anthropic', API_KEY, 'mem_admin', NOW);
    e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', 'run_q', 'myco-agent', 'title-summary', 'queued', ?, 'worker', ?, ?, 'do it')`,
      [NOW, JSON.stringify({ params: { session_id: 'fixture-session', mode: 'claim' }, serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
    );
    await ensureMember(e.db, 'mem_admin', NOW, 'admin', 'an administrator');
    const token = await issueMemberToken(e.db, { memberId: 'mem_admin', machineId: 'machine_admin' }, NOW, null, NO_RUNTIME_CLAIMS, { rotates });
    return { e, bindings, token };
  }

  it('is refused before anything is claimed: no run credential, no provider key, the run still queued', async () => {
    const { e, bindings, token } = await queued(false);
    const res = await worker.fetch(claimRequest(token.token), bindings as never);
    const body = await jsonBody(res);
    expect(body).toEqual({ persisted: false, code: 'non_rotating', reason: NON_ROTATING_AUTHORITY });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
    expect(e.sqlite.query(`SELECT status, dispatched_by FROM agent_runs WHERE id = 'run_q'`).get()).toEqual({ status: 'queued', dispatched_by: null });
    expect(e.sqlite.query(`SELECT COUNT(*) c FROM member_credentials`).get()).toEqual({ c: 1 });
  });

  it('from a credential that rotates, still claims the run and answers the harness its provider key', async () => {
    const { e, bindings, token } = await queued(true);
    await settingsWriter(e.db).setLeaf('agent.harnesses.claude-code.credential', 'deployment', 'mem_admin', Date.now());
    const body = await jsonBody(await worker.fetch(claimRequest(token.token), bindings as never)) as { claimed: boolean; run: { credentialEnv: Record<string, string> } };
    expect(body.claimed).toBe(true);
    expect(body.run.credentialEnv).toEqual({ ANTHROPIC_API_KEY: API_KEY });
    expect((e.sqlite.query(`SELECT status FROM agent_runs WHERE id = 'run_q'`).get() as { status: string }).status).not.toBe('queued');
  });
});
