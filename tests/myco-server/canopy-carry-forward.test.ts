import { afterEach, expect, it } from 'bun:test';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { dispatchTask, claimNextRun } from '@myco-server-worker/core/harness.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { MAX_MAP_CONTENT_AGE_MS } from '@myco-server-worker/core/canopy-carry-forward.js';
import { writeCanopyMap } from '@myco-server-worker/core/canopy.js';
import { connectRepository, githubFixture, SOURCE_URL, UNSIGNED_APP, withApp } from './helpers/github-app.js';
import { applyRunUpdate } from '@myco-server-worker/db/runs/change.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { readCanopyMap } from '@myco-server-worker/read/canopy.js';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { issueMemberToken } from './helpers/member-token.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { legacyWorker } from './helpers/worker-principal.js';

const SOURCE = { url: SOURCE_URL, branch: 'main' };
const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const SCOPE = { projectId: 'proj_1' };
const file = { path: 'src/main.ts', sha256: 'c'.repeat(64) };
const readme = { path: 'README.md', sha256: 'd'.repeat(64) };
const artifact = { directories: [{ path: 'src', annotation: 'Source.', groundedIn: [file] },
  { path: 'src/legacy', annotation: 'Old code.', groundedIn: [readme] }],
  domains: [{ id: 'main', title: 'Main', files: [{ path: file.path, annotation: 'Starts the app.', groundedIn: [file] }] }] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function fixture({ contentAgeMs = 0 }: { contentAgeMs?: number } = {}) {
  const e = sqliteEnv({ workerLogin: true });
  cleanups.push(() => e.sqlite.close());
  turnOnGatedCapabilities(e.sqlite);
  const now = Date.now();
  await completeBudgetMigration(e.db, now);
  await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
  const credential = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
  const principal = legacyWorker(credential.tokenId, 'm1');
  const github = githubFixture();
  const app = () => withApp(e.serverEnv, github);
  await connectRepository(app(), SCOPE.projectId, { actor: 'mem_worker', now });
  const start = async (actor: string, commit: string) => {
    const dispatch = await dispatchTask(app(), MAP_TASK, SCOPE.projectId, { serverUrl: 'https://s', actor }, now);
    if (!dispatch.dispatched) throw new Error('map not dispatched');
    const claim = await claimNextRun(app(), { principal, now, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES });
    if (!claim.claimed) throw new Error('map not claimed');
    const prepare = (body: Record<string, unknown>) => prepareWorkerRepository(app(),
      { worker: principal, clock: () => now }, { ...SCOPE, runId: claim.run.id, body });
    const access = await prepare({});
    await prepare({ ...SOURCE, commit });
    return { id: claim.run.id, prepare, access };
  };
  const initial = await start('mem_worker', OLD);
  expect(await writeCanopyMap(e.db, SCOPE, (await getRun(e.db, SCOPE, initial.id))!, artifact, now - contentAgeMs)).toBe(true);
  await applyRunUpdate(e.db, SCOPE, initial.id, { status: 'completed', completed_at: now });
  const before = (await readCanopyMap(e.db, SCOPE))!;
  const run = await start('clock', HEAD);
  const comparison = (run.access as { comparison: unknown }).comparison;
  const finish = (evidence: Record<string, unknown>) => run.prepare({ ...SOURCE, commit: HEAD, comparison: { ...comparison as object, ...evidence } });
  return { e, run, before, finish, start, now };
}

it('judges complete path evidence conservatively and preserves carried content authorship and age', async () => {
  const cases = [
    { name: 'deleted described directory', changes: [{ status: 'D', path: 'src/legacy/a.ts' }, { status: 'D', path: 'src/legacy/b.ts' }], carry: false },
    { name: 'directory replaced by a file', changes: [{ status: 'D', path: 'src/legacy/a.ts' }, { status: 'A', path: 'src/legacy' }], carry: false },
    { name: 'directory prefix without separator', changes: [{ status: 'A', path: 'src2/x.ts' }], carry: false },
    { name: 'grounded modification', changes: [{ status: 'M', path: file.path }], carry: false },
    { name: 'grounded file renamed', changes: [{ status: 'D', path: file.path }, { status: 'A', path: 'src/app.ts' }], carry: false },
    { name: 'move outside a described directory', changes: [{ status: 'D', path: 'src/x.ts' }, { status: 'A', path: 'lib/x.ts' }], carry: false },
    { name: 'move within a described directory', changes: [{ status: 'D', path: 'src/x.ts' }, { status: 'A', path: 'src/y/x.ts' }], carry: false },
    { name: 'case variant directory', changes: [{ status: 'A', path: 'Src/x.ts' }], carry: false },
    { name: 'ungrounded modification outside described directories', changes: [{ status: 'M', path: 'package.json' }], carry: true },
    { name: 'ungrounded addition inside a described directory', changes: [{ status: 'A', path: 'src/other.ts' }], carry: true },
  ];
  for (const row of cases) {
    const r = await fixture();
    try {
      const answer = await r.finish({ complete: true, changes: row.changes });
      const current = (await readCanopyMap(r.e.db, SCOPE))!;
      const run = (await getRun(r.e.db, SCOPE, r.run.id))!;
      expect({ case: row.name, carried: 'alreadyCurrent' in answer && answer.alreadyCurrent === true,
        held: answer.held, status: run.status, commit: current.repository.commit })
        .toEqual({ case: row.name, carried: row.carry, held: true, status: row.carry ? 'skipped' : 'running', commit: row.carry ? HEAD : OLD });
      expect(current).toMatchObject({ artifact, sourceRunId: r.before.sourceRunId, generatedAt: r.before.generatedAt });
      if (row.carry) {
        expect(JSON.parse(run.runContext!)).toEqual({ reason: 'input_unchanged' });
        expect(run.leaseExpiresAt).toBeNull();
        expect((await r.start('mem_worker', HEAD)).access).not.toHaveProperty('comparison');
      } else expect(current).toEqual(r.before);
    } finally { cleanups.pop()?.(); }
  }
});

it('refuses carry after exclusions change and leaves the run running with its map untouched', async () => {
  const r = await fixture();
  expect(await settingsWriter(r.e.db).setLeaf('cortex.canopy.exclude.patterns', ['generated/**'], 'mem_worker', r.now))
    .toMatchObject({ applied: true });
  expect(await r.finish({ complete: true, changes: [] })).not.toHaveProperty('alreadyCurrent');
  expect((await getRun(r.e.db, SCOPE, r.run.id))?.status).toBe('running');
  expect(await readCanopyMap(r.e.db, SCOPE)).toEqual(r.before);
});

it('keeps the run when the original map content is older than seven days', async () => {
  const r = await fixture({ contentAgeMs: MAX_MAP_CONTENT_AGE_MS + 1 });
  expect(r.run.access).not.toHaveProperty('comparison');
  expect((await getRun(r.e.db, SCOPE, r.run.id))?.status).toBe('running');
  expect(await readCanopyMap(r.e.db, SCOPE)).toEqual(r.before);
});

it('keeps the run when comparison evidence is incomplete or an older runner sends none', async () => {
  const r = await fixture();
  expect(await r.run.prepare({ ...SOURCE, commit: HEAD })).toMatchObject({ held: true, pin: { commit: HEAD } });
  expect(await r.finish({ complete: false, changes: [] })).not.toHaveProperty('alreadyCurrent');
  expect((await getRun(r.e.db, SCOPE, r.run.id))?.status).toBe('running');
  expect(await readCanopyMap(r.e.db, SCOPE)).toEqual(r.before);
});
