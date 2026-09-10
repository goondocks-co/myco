/**
 * External Agent grants: a Project's own credential class. Minted, rotated and
 * revoked by any member with attribution; the row names the Project and
 * nothing a caller sends widens it. Every grant carries an expiry and an
 * `agents` row, and neither the row nor the agent is ever deleted.
 */
import { jsonBody } from '../helpers/json-body.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import {
  authenticateGrant, expireGrants, GRANT_AGENT_FALLBACK_NAME, GRANT_AGENT_SOURCE, GRANT_EXPIRY_ACTOR,
  grantAgent, GRANT_KEY_PATTERN, GRANT_TOUCH_INTERVAL_MS, GRANT_TTL_DAYS_DEFAULT, GRANT_TTL_DAYS_MAX,
  issueExternalGrant, rotateExternalGrant, touchGrant,
} from '@myco-server-worker/auth/grants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, PRINCIPAL, asOwner, asOwnerPost } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

/** The agent row a grant writes under, or null where the mint left none. */
const agentOf = (e: ReturnType<typeof sqliteEnv>, grantId: string) =>
  e.sqlite.query(`SELECT id, name, source, enabled FROM agents WHERE id = ?`).get(grantId);

describe('external grants', () => {
  it('mints a key once for the path\'s project, stores only its digest, lists without it, and authenticates it to that project alone', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const minted = await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { label: 'review bot' }), env);
    expect(minted.status).toBe(201);
    const { key, id } = await minted.json() as { key: string; id: string };
    expect(GRANT_KEY_PATTERN.test(key)).toBe(true);
    expect(JSON.stringify(e.sqlite.query(`SELECT * FROM external_grants`).all())).not.toContain(key);

    const listed = await worker.fetch(await asOwner('/api/projects/proj_1/grants'), env);
    const raw = await listed.text();
    expect(raw).not.toContain(key);
    expect((JSON.parse(raw) as { grants: { id: string; label: string; createdBy: string }[] }).grants).toEqual([expect.objectContaining({ id, label: 'review bot', createdBy: PRINCIPAL.id })]);
    expect((await (await worker.fetch(await asOwner('/api/projects/proj_2/grants'), env)).json() as { grants: unknown[] }).grants).toEqual([]);

    expect(await authenticateGrant(e.db, await sha256Hex(key), Date.now())).toEqual({ grantId: id, projectId: 'proj_1' });
    expect(await authenticateGrant(e.db, await sha256Hex('mycoext_' + 'x'.repeat(43)), Date.now())).toBeNull();
  });

  it('mints an agent row named for the grant, one per grant id, so a write can name it', async () => {
    const e = sqliteEnv();
    const labelled = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'review bot', 'mem_machine_1', NOW);
    const unlabelled = await issueExternalGrant(e.db, { projectId: 'proj_1' }, null, 'mem_machine_1', NOW);
    expect(agentOf(e, labelled.id)).toEqual({ id: labelled.id, name: 'review bot', source: GRANT_AGENT_SOURCE, enabled: 1 });
    expect(agentOf(e, unlabelled.id)).toEqual({ id: unlabelled.id, name: GRANT_AGENT_FALLBACK_NAME, source: GRANT_AGENT_SOURCE, enabled: 1 });
  });

  it('answers the expiry it minted, takes the default window when the caller names none, and holds a named window to its bounds', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const defaulted = await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', {}), env);
    const { id, expiresAt } = await defaulted.json() as { id: string; expiresAt: number };
    const created = (e.sqlite.query(`SELECT created_at FROM external_grants WHERE id = ?`).get(id) as { created_at: number }).created_at;
    expect(expiresAt - created).toBe(GRANT_TTL_DAYS_DEFAULT * DAY_MS);

    const named = await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { expires_in_days: 7 }), env);
    const week = await named.json() as { id: string; expiresAt: number };
    const weekCreated = (e.sqlite.query(`SELECT created_at FROM external_grants WHERE id = ?`).get(week.id) as { created_at: number }).created_at;
    expect(week.expiresAt - weekCreated).toBe(7 * DAY_MS);

    const before = e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get();
    for (const bad of [0, -1, GRANT_TTL_DAYS_MAX + 1, 1.5, '30', null]) {
      const refused = await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { expires_in_days: bad }), env);
      expect({ bad, status: refused.status }).toEqual({ bad, status: 400 });
    }
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual(before);
  });

  it('refuses a mint for a project the minter cannot see, and a label out of bounds, leaving no grant and no agent', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_missing/grants', {}), env)).status).toBe(404);
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { label: 'x'.repeat(81) }), env)).status).toBe(400);
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual({ c: 0 });
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM agents WHERE source = ?`).get(GRANT_AGENT_SOURCE)).toEqual({ c: 0 });
  });

  it('rotates in one step: the old key is refused and the new one admitted the same instant, attributed, with its own agent row', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const first = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW);
    const rotated = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/grants/${first.id}/rotate`), env);
    expect(rotated.status).toBe(201);
    const { key, id } = await rotated.json() as { key: string; id: string };
    expect(await authenticateGrant(e.db, await sha256Hex(first.key), Date.now())).toBeNull();
    expect(await authenticateGrant(e.db, await sha256Hex(key), Date.now())).toEqual({ grantId: id, projectId: 'proj_1' });
    expect(e.sqlite.query(`SELECT revoked_by, rotated_to, label FROM external_grants WHERE id = ?`).get(first.id)).toEqual({ revoked_by: PRINCIPAL.id, rotated_to: id, label: 'bot' });
    expect(e.sqlite.query(`SELECT label, project_id FROM external_grants WHERE id = ?`).get(id)).toEqual({ label: 'bot', project_id: 'proj_1' });
    expect(agentOf(e, id)).toEqual({ id, name: 'bot', source: GRANT_AGENT_SOURCE, enabled: 1 });
    expect(agentOf(e, first.id)).not.toBeNull();
  });

  it('carries the predecessor\'s window into the successor and starts it again, rather than widening it', async () => {
    const e = sqliteEnv();
    const first = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW, 7);
    const at = NOW + 3 * DAY_MS;
    const second = await rotateExternalGrant(e.db, { projectId: 'proj_1' }, first.id, 'mem_machine_1', at);
    expect(second!.expiresAt).toBe(at + 7 * DAY_MS);
    expect(e.sqlite.query(`SELECT expires_at FROM external_grants WHERE id = ?`).get(second!.id)).toEqual({ expires_at: at + 7 * DAY_MS });
  });

  it('refuses to rotate a grant past its expiry, leaving no successor and no agent row', async () => {
    const e = sqliteEnv();
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW, 1);
    const after = NOW + 2 * DAY_MS;
    expect(await rotateExternalGrant(e.db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', after)).toBeNull();
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual({ c: 1 });
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM agents WHERE source = ?`).get(GRANT_AGENT_SOURCE)).toEqual({ c: 1 });
  });

  it('rotates and revokes only within the path\'s project, leaving no successor behind on a refusal', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, null, 'mem_machine_1', NOW);
    expect((await worker.fetch(await asOwnerPost(`/api/projects/proj_2/grants/${grant.id}/rotate`), env)).status).toBe(404);
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual({ c: 1 });
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM agents WHERE source = ?`).get(GRANT_AGENT_SOURCE)).toEqual({ c: 1 });
    expect(await authenticateGrant(e.db, await sha256Hex(grant.key), NOW)).not.toBeNull();
    expect(await jsonBody((await worker.fetch(await asOwnerPost(`/api/projects/proj_2/grants/${grant.id}/revoke`), env)))).toEqual({ revoked: false, revokedBy: PRINCIPAL.id });
    expect(await jsonBody((await worker.fetch(await asOwnerPost(`/api/projects/proj_1/grants/${grant.id}/revoke`), env)))).toEqual({ revoked: true, revokedBy: PRINCIPAL.id });
    expect(await authenticateGrant(e.db, await sha256Hex(grant.key), NOW)).toBeNull();
    expect(await rotateExternalGrant(e.db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', NOW)).toBeNull();
  });

  it('refuses a lapsed key and one whose expiry the store lost, and admits the same key one instant earlier', async () => {
    const e = sqliteEnv();
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, null, 'mem_machine_1', NOW, 1);
    const digest = await sha256Hex(grant.key);
    const at = NOW + DAY_MS;
    expect(await authenticateGrant(e.db, digest, at - 1)).toEqual({ grantId: grant.id, projectId: 'proj_1' });
    expect(await authenticateGrant(e.db, digest, at)).toBeNull();
    e.sqlite.query(`UPDATE external_grants SET expires_at = NULL WHERE id = ?`).run(grant.id);
    expect(await authenticateGrant(e.db, digest, NOW)).toBeNull();
  });

  it('ends every lapsed grant at the instant it expired, converges on a second pass, and destroys nothing', async () => {
    const e = sqliteEnv();
    const lapsed = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW, 1);
    const live = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'live', 'mem_machine_1', NOW, 30);
    const expiresAt = (e.sqlite.query(`SELECT expires_at FROM external_grants WHERE id = ?`).get(lapsed.id) as { expires_at: number }).expires_at;
    const at = NOW + 5 * DAY_MS;

    expect(await expireGrants(e.db, at, 500)).toBe(1);
    expect(e.sqlite.query(`SELECT revoked_at, revoked_by FROM external_grants WHERE id = ?`).get(lapsed.id))
      .toEqual({ revoked_at: expiresAt, revoked_by: GRANT_EXPIRY_ACTOR });
    expect(await expireGrants(e.db, at + 1_000, 500)).toBe(0);
    expect(e.sqlite.query(`SELECT revoked_at FROM external_grants WHERE id = ?`).get(lapsed.id)).toEqual({ revoked_at: expiresAt });
    expect(e.sqlite.query(`SELECT revoked_at FROM external_grants WHERE id = ?`).get(live.id)).toEqual({ revoked_at: null });
    expect(agentOf(e, lapsed.id)).not.toBeNull();
  });

  it('sweeps a grant carrying no expiry at the instant it is found, so nothing authentication refuses is left listed as live', async () => {
    const e = sqliteEnv();
    const orphan = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'no window', 'mem_machine_1', NOW);
    e.sqlite.query(`UPDATE external_grants SET expires_at = NULL WHERE id = ?`).run(orphan.id);
    expect(await authenticateGrant(e.db, await sha256Hex(orphan.key), NOW)).toBeNull();

    const at = NOW + 5 * DAY_MS;
    expect(await expireGrants(e.db, at, 500)).toBe(1);
    expect(e.sqlite.query(`SELECT revoked_at, revoked_by FROM external_grants WHERE id = ?`).get(orphan.id))
      .toEqual({ revoked_at: at, revoked_by: GRANT_EXPIRY_ACTOR });
    expect(await expireGrants(e.db, at + 1_000, 500)).toBe(0);
    expect(agentOf(e, orphan.id)).not.toBeNull();
  });

  it('bounds one pass of the expiry job and takes the rest on the next', async () => {
    const e = sqliteEnv();
    for (let i = 0; i < 3; i += 1) await issueExternalGrant(e.db, { projectId: 'proj_1' }, `bot-${i}`, 'mem_machine_1', NOW, 1);
    const at = NOW + 5 * DAY_MS;
    expect(await expireGrants(e.db, at, 2)).toBe(2);
    expect(await expireGrants(e.db, at, 2)).toBe(1);
    expect(await expireGrants(e.db, at, 2)).toBe(0);
  });

  it('gives a grant minted before it had an agent row one, so its first write is not refused by the key it hangs on', async () => {
    const e = sqliteEnv();
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'legacy bot', 'mem_machine_1', NOW);
    // The shape of a grant that predates this column's owner: the row, no agent.
    e.sqlite.query(`DELETE FROM agents WHERE id = ?`).run(grant.id);
    expect(agentOf(e, grant.id)).toBeNull();
    const writes = () => {
      try {
        e.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, observation_type, content, author, created_at)
                        VALUES ('proj_1', ?, ?, 'discovery', 'x', ?, ?)`).run(`sp-${grant.id}`, grant.id, grant.id, NOW);
        return true;
      } catch { return false; }
    };
    expect(writes()).toBe(false);

    for (const statement of SCHEMA_DDL.filter((x) => !/ALTER TABLE \w+ ADD COLUMN/.test(x))) e.sqlite.exec(statement);
    expect(agentOf(e, grant.id)).toEqual({ id: grant.id, name: 'legacy bot', source: GRANT_AGENT_SOURCE, enabled: 1 });
    expect(writes()).toBe(true);
  });

  it('mints the agent row again without failing, so a re-run of the mint is a no-op rather than a conflict', async () => {
    const e = sqliteEnv();
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW);
    await grantAgent(e.db, grant.id, NOW).run();
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM agents WHERE id = ?`).get(grant.id)).toEqual({ c: 1 });
    expect(agentOf(e, grant.id)).toMatchObject({ name: 'bot' });
  });

  it('records use at most once per interval, in the statement, and never for a revoked grant', async () => {
    const e = sqliteEnv();
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, null, 'mem_machine_1', NOW);
    expect(await touchGrant(e.db, grant.id, NOW)).toEqual({ touched: true });
    expect(await touchGrant(e.db, grant.id, NOW + 1)).toEqual({ touched: false });
    expect(await touchGrant(e.db, grant.id, NOW + GRANT_TOUCH_INTERVAL_MS + 1)).toEqual({ touched: true });
    e.sqlite.query(`UPDATE external_grants SET revoked_at = ? WHERE id = ?`).run(NOW, grant.id);
    expect(await touchGrant(e.db, grant.id, NOW + 2 * GRANT_TOUCH_INTERVAL_MS)).toEqual({ touched: false });
  });
});
