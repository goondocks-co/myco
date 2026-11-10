/**
 * Auto-join's reads and writes (a repository a machine reports uncaptured, resolving a repository to its Project, what a
 * machine is told it connected) cost the same on D1 when a Deployment holds ten times the reports and remotes, with
 * and without planner statistics.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { clearUncapturedStatement, heldUncapturedStatement, pruneUncaptured, recordUncapturedStatement } from '@myco-server-worker/ingest/uncaptured.js';
import { remoteHolder, resolveRepository } from '@myco-server-worker/core/remotes.js';
import { connectedRoot, connectMachineRoot } from '@myco-server-worker/core/machine-settings.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_800_000_000_000;
/** A root key for each run of a case: the warm-up, the small size and the large. */
const keyOf = (scale: number) => ['b', 'c', 'd'][scale + 1]!.repeat(16);

async function setup(db: RelationalStore) {
  await db.prepare("INSERT INTO members(id,label,created_at) VALUES('mem_1','member',1),('mem_2','other',1)").run();
  await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine_1','mem_1',1)").run();
  for (const project of ['proj_0', 'proj_1']) await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
  await db.prepare("INSERT INTO project_remotes(remote,project_id,first_seen_at) VALUES('github.com/acme/widget','proj_0',1)").run();
}

/** Each unit is a repository another machine reported recently, a remote one of the Projects holds, and another member's machine told what to connect. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO machine_claims(machine_id,member_id,claimed_at) SELECT 'machine-u'||i,'mem_2',1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO machine_settings(machine_id,leaf,value,updated_at,updated_by)
    SELECT 'machine-u'||i,'capture.connect_roots',json_object(printf('%016x',i),''),1,'mem_2' FROM n`);
  await eachUnit(db, from, to, `INSERT INTO uncaptured_roots(machine_id,root_key,member_id,label,remote,reason,held,first_seen_at,last_seen_at)
    SELECT 'machine-'||(i%50),printf('%016x',i),'mem_2','repo '||i,'github.com/other/repo-'||i,'no_remote','held',?3,?3 FROM n`, NOW);
  await eachUnit(db, from, to, `INSERT INTO project_remotes(remote,project_id,first_seen_at) SELECT 'github.com/acme/repo-'||i,'proj_'||(i%2),1 FROM n`);
}

it('auto-join reports, resolutions and connections cost D1 the same as reports and remotes grow', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup,
    grow,
    cases: [
      { name: 'report, hold and forget a repository', run: async (db, { scale }) => {
        const key = keyOf(scale);
        await recordUncapturedStatement(db, { machineId: 'machine_1', memberId: 'mem_1', rootKey: key, label: 'widget', remote: null, reason: 'no_remote', held: 'held', sessions: 1, now: NOW }).run();
        await heldUncapturedStatement(db, 'machine_1', key, 'full').run();
        await clearUncapturedStatement(db, 'machine_1', key).run();
      } },
      { name: 'prune stale reports', run: async (db) => expect(await pruneUncaptured(db, NOW, 100)).toBe(0) },
      {
        name: 'resolve a repository',
        run: async (db, { scale }) => {
          expect(await resolveRepository(db, { remote: 'github.com/acme/widget', name: 'widget', allowCreate: true, projectId: 'proj_unused', now: 1, maxProjects: 1_000 }))
            .toMatchObject({ resolved: true, projectId: 'proj_0', created: false });
          expect(await resolveRepository(db, { remote: `github.com/acme/new-${scale + 1}`, name: 'new', allowCreate: true, projectId: `proj_new_${scale + 1}`, now: 1, maxProjects: 1_000 }))
            .toMatchObject({ resolved: true, created: true });
          await resolveRepository(db, { remote: null, name: `notes-${scale + 1}`, allowCreate: true, projectId: `proj_notes_${scale + 1}`, now: 1, maxProjects: 1_000 });
        },
      },
      { name: 'remote holder', run: async (db) => expect(await remoteHolder(db, 'github.com/acme/widget')).toEqual({ projectId: 'proj_0', archived: false }) },
      { name: 'connect a machine root', run: async (db, { scale }) => {
        await connectMachineRoot(db, 'machine_1', keyOf(scale), '', 'mem_1', 1);
        await connectedRoot(db, 'machine_1', keyOf(scale));
      } },
    ],
    warm: true,
  }));
}, 180_000);
