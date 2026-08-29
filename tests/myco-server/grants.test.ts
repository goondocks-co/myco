/**
 * External Agent grants: a Project's read-only credential class. Minted,
 * rotated and revoked by any member with attribution; the row names the
 * Project and nothing a caller sends widens it.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { authenticateGrant, GRANT_KEY_PATTERN, GRANT_TOUCH_INTERVAL_MS, issueExternalGrant, rotateExternalGrant, touchGrant } from '@myco-server-worker/auth/grants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, PRINCIPAL, asOwner, asOwnerPost } from './helpers/owner.js';

const NOW = 1_800_000_000_000;

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

    expect(await authenticateGrant(e.db, await sha256Hex(key))).toEqual({ grantId: id, projectId: 'proj_1' });
    expect(await authenticateGrant(e.db, await sha256Hex('mycoext_' + 'x'.repeat(43)))).toBeNull();
  });

  it('refuses a mint for a project the minter cannot see, and a label out of bounds', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_missing/grants', {}), env)).status).toBe(404);
    expect((await worker.fetch(await asOwnerPost('/api/projects/proj_1/grants', { label: 'x'.repeat(81) }), env)).status).toBe(400);
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual({ c: 0 });
  });

  it('rotates in one step: the old key is refused and the new one admitted the same instant, attributed', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const first = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'bot', 'mem_machine_1', NOW);
    const rotated = await worker.fetch(await asOwnerPost(`/api/projects/proj_1/grants/${first.id}/rotate`), env);
    expect(rotated.status).toBe(201);
    const { key, id } = await rotated.json() as { key: string; id: string };
    expect(await authenticateGrant(e.db, await sha256Hex(first.key))).toBeNull();
    expect(await authenticateGrant(e.db, await sha256Hex(key))).toEqual({ grantId: id, projectId: 'proj_1' });
    expect(e.sqlite.query(`SELECT revoked_by, rotated_to, label FROM external_grants WHERE id = ?`).get(first.id)).toEqual({ revoked_by: PRINCIPAL.id, rotated_to: id, label: 'bot' });
    expect(e.sqlite.query(`SELECT label, project_id FROM external_grants WHERE id = ?`).get(id)).toEqual({ label: 'bot', project_id: 'proj_1' });
  });

  it('rotates and revokes only within the path\'s project, leaving no successor behind on a refusal', async () => {
    const e = sqliteEnv();
    const env = { ...e.env, ...OWNER_ENV };
    const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, null, 'mem_machine_1', NOW);
    expect((await worker.fetch(await asOwnerPost(`/api/projects/proj_2/grants/${grant.id}/rotate`), env)).status).toBe(404);
    expect(e.sqlite.query(`SELECT COUNT(*) AS c FROM external_grants`).get()).toEqual({ c: 1 });
    expect(await authenticateGrant(e.db, await sha256Hex(grant.key))).not.toBeNull();
    expect(await (await worker.fetch(await asOwnerPost(`/api/projects/proj_2/grants/${grant.id}/revoke`), env)).json()).toEqual({ revoked: false, revokedBy: PRINCIPAL.id });
    expect(await (await worker.fetch(await asOwnerPost(`/api/projects/proj_1/grants/${grant.id}/revoke`), env)).json()).toEqual({ revoked: true, revokedBy: PRINCIPAL.id });
    expect(await authenticateGrant(e.db, await sha256Hex(grant.key))).toBeNull();
    expect(await rotateExternalGrant(e.db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', NOW)).toBeNull();
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
