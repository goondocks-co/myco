import { expect, it } from 'bun:test';
import { writeCanopyMap, canopyMapWrittenBy } from '@myco-server-worker/core/canopy.js';
import { readCanopyMap } from '@myco-server-worker/read/canopy.js';
import { getRun, pinMapSourceForRun, pinRepositoryForRun } from '@myco-server-worker/core/runs.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';

const source = { path: 'src/main.ts', sha256: 'a'.repeat(64) };
const artifact = {
  directories: [{ path: 'src', annotation: 'Source.', groundedIn: [source] }],
  domains: [{ id: 'main', title: 'Main', files: [{ path: source.path, annotation: 'Starts the app.', groundedIn: [source] }] }],
};
const repository = { url: 'https://example.test/repo.git', branch: 'main', commit: 'b'.repeat(40) };
const scope = { projectId: 'proj_1' };

async function fixture() {
  const r = sqliteEnv();
  const tokenId = seedCredential(r.sqlite, { memberId: 'mem_harness', machineId: 'harness' });
  r.sqlite.query("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco','Myco','built-in',1,0)").run();
  await projectRepositories(r.db, deploymentSecretStore(r.db, r.serverEnv.wrappingKey)).save(scope.projectId, { ...repository, revision: null }, 'mem_machine_1', 0);
  const run = async (id: string, priorRevision: string | null, inputHash = 'c'.repeat(64)) => {
    r.sqlite.query("INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,dispatched_by,run_context) VALUES ('proj_1',?,'myco','canopy-map','running',0,?,'{}')").run(id, tokenId);
    const row = (await getRun(r.db, scope, id))!;
    await pinRepositoryForRun(r.db, scope, row, repository);
    await pinMapSourceForRun(r.db, scope, row, { inputHash, priorRevision });
    return (await getRun(r.db, scope, id))!;
  };
  return { ...r, run };
}

it('publishes the prepared map once, reads it by project and verifies unchanged source without rewriting', async () => {
  const r = await fixture();
  const run = await r.run('one', null);
  expect(await writeCanopyMap(r.db, scope, run, artifact, 1)).toBe(true);
  const first = (await readCanopyMap(r.db, scope))!;
  expect(first.repository).toEqual(repository);
  expect(first.content).toContain('Map Provenance');
  expect(await readCanopyMap(r.db, { projectId: 'proj_2' })).toBeNull();
  expect(await writeCanopyMap(r.db, scope, run, artifact, 2)).toBe(true);
  expect((await readCanopyMap(r.db, scope))?.revision).toBe(first.revision);
  const unchanged = await r.run('unchanged', first.revision);
  expect(await canopyMapWrittenBy(r.db, scope, unchanged)).toBe(true);
  expect((await readCanopyMap(r.db, scope))?.generatedAt).toBe(1);
  r.sqlite.close();
});

it('refuses stale maps, changed repositories and dry runs while retaining the current artifact', async () => {
  const r = await fixture();
  const initial = await r.run('initial', null);
  expect(await writeCanopyMap(r.db, scope, initial, artifact, 1)).toBe(true);
  const first = (await readCanopyMap(r.db, scope))!;
  const a = await r.run('a', first.revision, 'd'.repeat(64));
  const b = await r.run('b', first.revision, 'e'.repeat(64));
  expect(await writeCanopyMap(r.db, scope, a, artifact, 2)).toBe(true);
  expect(await writeCanopyMap(r.db, scope, b, artifact, 3)).toBe(false);
  expect(await canopyMapWrittenBy(r.db, scope, b)).toBe(false);
  const next = (await readCanopyMap(r.db, scope))!;
  const dry = await r.run('dry', next.revision);
  expect(await writeCanopyMap(r.db, scope, { ...dry, dryRun: 1 }, artifact, 4)).toBe(false);
  r.sqlite.query("UPDATE project_repositories SET branch='other'").run();
  expect(await writeCanopyMap(r.db, scope, dry, artifact, 4)).toBe(false);
  expect((await readCanopyMap(r.db, scope))?.revision).toBe(next.revision);
  r.sqlite.close();
});
