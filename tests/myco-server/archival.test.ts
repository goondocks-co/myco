/**
 * Project archival.
 *
 * An archived project refuses capture on the two capture routes with a named,
 * terminal refusal in each route's shape, and on nothing else: the credential
 * still rotates and the run control plane still answers. Listings hide it by
 * default and show it on request; everything captured stays readable; unarchive
 * restores capture.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { blobPost, envelope, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

async function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const now = Date.now();
  const token = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now)).token;
  const windowed = (await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2))).token;
  const fetch = (req: Request) => worker.fetch(req, env);
  const owner = async (path: string) => json(await fetch(await asOwner(path)));
  const ownerPost = async (path: string, body?: unknown) => fetch(await asOwnerPost(path, body));
  const post = async (over: Record<string, unknown> = {}, project?: string) => json(await fetch(memberPost(token, envelope(over), '/events', project === undefined ? {} : { [PROJECT_HEADER]: project })));
  const count = (table: string) => (fixture.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...fixture, env, token, windowed, fetch, owner, ownerPost, post, count };
}

describe('an archived project', () => {
  it('refuses capture on both capture routes, in each route\'s shape, by name, storing nothing', async () => {
    const r = await rig();
    expect((await json(await r.ownerPost('/api/projects/proj_1/archive'))).archived).toBe(true);
    const before = { events: r.count('events'), blobs: r.count('blobs') };

    const event = await r.post({ eventId: uuid(11) });
    expect(event).toEqual({ persisted: false, code: 'project_archived', reason: expect.stringContaining('archived') });
    const bytes = utf8('archived bytes');
    const blob = await json(await r.fetch(blobPost(r.token, await sha256HexOf(bytes), bytes)));
    expect(blob).toEqual({ stored: false, code: 'project_archived', reason: expect.stringContaining('archived') });
    expect({ events: r.count('events'), blobs: r.count('blobs') }).toEqual(before);
  });

  it('leaves the credential and the run control plane alone: a refresh still rotates and a claim still claims', async () => {
    const r = await rig();
    await r.ownerPost('/api/projects/proj_1/archive');
    const refreshed = await json(await r.fetch(memberPost(r.windowed, {}, '/tokens/refresh')));
    expect(refreshed.refreshed).toBe(true);
    const claim = await json(await r.fetch(memberPost(r.token, { id: 'run_arch', agentId: 'agent_arch', task: 'digest', capability: 'cortex' }, '/runs/claim')));
    expect(claim.persisted).toBe(true);
  });

  it('is restored by unarchive: capture answers persisted again', async () => {
    const r = await rig();
    await r.ownerPost('/api/projects/proj_1/archive');
    expect((await r.post({ eventId: uuid(12) })).code).toBe('project_archived');
    expect((await json(await r.ownerPost('/api/projects/proj_1/unarchive'))).archived).toBe(false);
    expect((await r.post({ eventId: uuid(13) })).persisted).toBe(true);
  });

  it('does not stop a project the server has never seen from being resolved into existence, unarchived', async () => {
    const r = await rig();
    await r.ownerPost('/api/projects/proj_1/archive');
    expect((await r.post({ eventId: uuid(14) }, 'proj_fresh')).persisted).toBe(true);
    const listed = (await r.owner('/api/projects')).projects as { projectId: string }[];
    expect(listed.map((p) => p.projectId)).toContain('proj_fresh');
  });

  it('leaves the default listing and appears on request, with who archived it; the status receipt marks it', async () => {
    const r = await rig();
    await r.ownerPost('/api/projects/proj_1/archive');
    const hidden = (await r.owner('/api/projects')).projects as { projectId: string }[];
    expect(hidden.map((p) => p.projectId)).toEqual(['proj_2']);
    const shown = (await r.owner('/api/projects?include=archived')).projects as { projectId: string; archivedAt: number | null; archivedBy: string | null }[];
    expect(shown.map((p) => [p.projectId, p.archivedAt !== null, p.archivedBy])).toEqual(expect.arrayContaining([['proj_1', true, 'mem_machine_1'], ['proj_2', false, null]]));
    const receipts = (await r.owner('/api/status')).projects as { projectId: string; archivedAt: number | null }[];
    expect(receipts.find((p) => p.projectId === 'proj_1')?.archivedAt).not.toBeNull();
    expect(receipts.map((p) => p.projectId).sort()).toEqual(['proj_1', 'proj_2']);
  });

  it('is attributed, refuses a second archive and a spare unarchive by name, and answers 404 for a project the server does not hold', async () => {
    const r = await rig();
    const first = await r.ownerPost('/api/projects/proj_1/archive');
    expect({ status: first.status, body: await json(first) }).toEqual({ status: 200, body: { archived: true, archivedBy: 'mem_machine_1' } });
    const again = await r.ownerPost('/api/projects/proj_1/archive');
    expect({ status: again.status, body: await json(again) }).toEqual({ status: 409, body: { error: 'already_archived' } });
    const spare = await r.ownerPost('/api/projects/proj_2/unarchive');
    expect({ status: spare.status, body: await json(spare) }).toEqual({ status: 409, body: { error: 'not_archived' } });
    expect((await r.ownerPost('/api/projects/absent/archive')).status).toBe(404);
    expect((await r.ownerPost('/api/projects/absent/unarchive')).status).toBe(404);
  });

  it('keeps everything captured readable', async () => {
    const r = await rig();
    expect((await r.post({ eventId: uuid(15) })).persisted).toBe(true);
    await r.ownerPost('/api/projects/proj_1/archive');
    const sessions = await r.fetch(await asOwner('/api/projects/proj_1/sessions'));
    expect(sessions.status).toBe(200);
    expect(((await json(sessions)).rows as unknown[]).length).toBe(1);
    expect((await r.fetch(await asOwner('/api/projects/proj_1/activity'))).status).toBe(200);
  });
});
