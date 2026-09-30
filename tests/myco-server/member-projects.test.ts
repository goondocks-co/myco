/**
 * `POST /members/projects/list` and `POST /members/projects`: a member's own view of the Deployment's projects, and
 * the project it creates to connect a folder to (#1499). Any live member reaches both over its CLI credential;
 * creation is capture's own implicit creation made explicit, under the same ceiling.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_PROJECTS } from '@myco-server-worker/constants.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const post = (path: string, token: string, body: unknown) =>
  new Request(`https://s${path}`, { method: 'POST', headers: { ...memberHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a member\'s projects', () => {
  it('lists the projects that accept capture, and creates a named one a member (not only an admin) asks for', async () => {
    const e = sqliteEnv();
    e.sqlite.run(`UPDATE projects SET archived_at = 1, archived_by = 'mem_m' WHERE project_id = 'proj_2'`);
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const listed = await (await worker.fetch(post('/members/projects/list', t.token, {}), e.env)).json() as { persisted: boolean; projects: { projectId: string; name: string }[] };
    expect(listed.persisted).toBe(true);
    expect(listed.projects.map((p) => p.projectId)).toEqual(['proj_1']);

    const made = await (await worker.fetch(post('/members/projects', t.token, { name: '  billing-service ' }), e.env)).json() as { persisted: boolean; projectId: string; name: string };
    expect(made).toMatchObject({ persisted: true, name: 'billing-service' });
    expect(made.projectId).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(e.sqlite.query('SELECT name FROM projects WHERE project_id = ?').get(made.projectId)).toEqual({ name: 'billing-service' });
    const again = await (await worker.fetch(post('/members/projects/list', t.token, {}), e.env)).json() as { projects: { projectId: string }[] };
    expect(again.projects.map((p) => p.projectId)).toContain(made.projectId);
  });

  it('refuses a name it cannot hold and a Deployment at its ceiling, creating nothing', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const count = () => (e.sqlite.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    const before = count();
    for (const name of ['', '   ', 'x'.repeat(201), 42]) {
      const refused = await (await worker.fetch(post('/members/projects', t.token, { name }), e.env)).json() as { persisted: boolean; code: string };
      expect({ name, persisted: refused.persisted, code: refused.code }).toEqual({ name, persisted: false, code: 'invalid_field' });
    }
    expect(count()).toBe(before);
    for (let i = count(); i < MAX_PROJECTS; i += 1) e.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, 0)`, [`proj_fill_${i}`, `fill ${i}`]);
    const full = await (await worker.fetch(post('/members/projects', t.token, { name: 'one more' }), e.env)).json() as { persisted: boolean; reason: string };
    expect(full.persisted).toBe(false);
    expect(full.reason).toContain(`${MAX_PROJECTS} projects`);
    expect(count()).toBe(MAX_PROJECTS);
  });
});
