/**
 * The backup surface over the deployed entry: envelopes, auth, and the flow.
 * The engine's own behaviors are proven in `backup.test.ts`; this holds what
 * a caller of the routes actually sees.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const setup = () => {
  const e = sqliteEnv();
  return { ...e, env: { ...e.env, ...OWNER_ENV } };
};

describe('the backup routes', () => {
  it('refuses an anonymous caller on every route', async () => {
    const { env } = setup();
    for (const [method, path] of [['POST', '/api/backups'], ['GET', '/api/backups'], ['POST', '/api/backups/bk_x/restore']] as const) {
      const res = await worker.fetch(new Request(`https://s${path}`, { method, headers: { 'cf-connecting-ip': '1.2.3.4' } }), env);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  it('creates, lists verified, previews, pins, and restores through the envelopes', async () => {
    const { env } = setup();
    const created = await worker.fetch(await asOwnerPost('/api/backups', {}), env);
    const createdBody = await created.json() as { backup: { id: string }; pruned: number };
    expect({ status: created.status, pruned: createdBody.pruned }).toEqual({ status: 200, pruned: 0 });
    const id = createdBody.backup.id;

    const listed = await worker.fetch(await asOwner('/api/backups'), env);
    const listedBody = await listed.json() as { backups: Array<{ id: string; present: boolean; pinned: number }> };
    expect(listedBody.backups.map((b) => ({ id: b.id, present: b.present }))).toEqual([{ id, present: true }]);

    const preview = await worker.fetch(await asOwnerPost(`/api/backups/${id}/restore-preview`, {}), env);
    const previewBody = await preview.json() as { foreignLineage: boolean; header: { counts: Record<string, number> } };
    expect({ status: preview.status, foreign: previewBody.foreignLineage }).toEqual({ status: 200, foreign: false });

    const pinned = await worker.fetch(await asOwnerPost(`/api/backups/${id}/pin`, { pinned: true }), env);
    expect({ status: pinned.status, body: await pinned.json() }).toEqual({ status: 200, body: { pinned: true } });

    const restored = await worker.fetch(await asOwnerPost(`/api/backups/${id}/restore`, {}), env);
    const restoredBody = await restored.json() as { applied: boolean; tables: Record<string, { inserted: number }> };
    expect({ status: restored.status, applied: restoredBody.applied }).toEqual({ status: 200, applied: true });
    expect(Object.values(restoredBody.tables).every((t) => t.inserted === 0)).toBe(true);
  });

  it('answers 404 for an unknown id and refuses a malformed pin body', async () => {
    const { env } = setup();
    const missing = await worker.fetch(await asOwnerPost('/api/backups/bk_ghost/restore-preview', {}), env);
    expect(missing.status).toBe(404);
    const created = await worker.fetch(await asOwnerPost('/api/backups', {}), env);
    const id = ((await created.json()) as { backup: { id: string } }).backup.id;
    const bad = await worker.fetch(await asOwnerPost(`/api/backups/${id}/pin`, { pinned: 'yes' }), env);
    expect(bad.status).toBe(400);
  });
});
