import { stampRequest, lastActivityAt, REQUEST_STAMP_INTERVAL_MS } from '@myco-server-worker/core/activity.js';
import type { MaintenanceOutcome } from '@myco-server-worker/core/store-maintenance.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BUDGET_INDEXES, budgetActivation, budgetQueueOpenedAt, completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { backupPruneStatus, recordBackupPrune, type BackupPruneOutcome } from '@myco-server-worker/db/meta/backup-prune.js';
import { claimMaintenanceOutcome, maintenanceOutcomeText } from '@myco-server-worker/db/maintenance/outcomes.js';
import { repairLearningSources } from '@myco-server-worker/db/learning/source-repair.js';
import { createProject } from '@myco-server-worker/db/storage/projects.js';
import { ESTIMATE_RACES } from './estimate-races.js';
import { bothOrders, check, equal, lockstep, PROJECT, rows, sweep } from './store-race.js';

/** Concurrent writers to one Deployment-wide record: the budget governor's activation, and the passes that record their own outcome. */

const budgetActivationRaces = async (db: RelationalStore): Promise<void> => {
  const catalogue = async () => {
    const found = await rows<{ name: string; id: number }>(db, "SELECT name,rowid AS id FROM sqlite_master WHERE type='index'");
    return JSON.stringify(BUDGET_INDEXES.map((index) => found.find((row) => row.name === index.name)?.id));
  };
  const witness = async () => (await rows<{ value: string }>(db, "SELECT value FROM schema_meta WHERE key='budget_index_rows'")).map((row) => row.value);
  // A Deployment whose activation has not run, or stopped after preparing its indexes.
  const unactivated = async () => { await db.prepare("DELETE FROM schema_meta WHERE key LIKE 'budget\\_%' ESCAPE '\\'").run(); };
  const activated = async (results: unknown[], at: string) => {
    equal(results, [{ active: true, reason: null }, { active: true, reason: null }], `both racing activations answer an active governor (${at})`);
    equal(await budgetActivation(db), { active: true, reason: null }, `two racing activations leave the governor active (${at})`);
    check(['100', '200'].includes(String(await budgetQueueOpenedAt(db))), `the queue opens at one racing activation's instant (${at})`);
    equal(await witness(), [await catalogue()], `two racing activations publish one witness naming the current index catalogue (${at})`);
  };
  for (const order of [0, 1]) {
    await unactivated();
    const results = order === 0
      ? await lockstep(db, (s) => completeBudgetMigration(s, 100), (s) => completeBudgetMigration(s, 200))
      : await lockstep(db, (s) => completeBudgetMigration(s, 200), (s) => completeBudgetMigration(s, 100));
    await activated(results, `alternating, order ${order}`);
  }
  await sweep(db, {
    before: unactivated,
    left: () => (s) => completeBudgetMigration(s, 100),
    right: () => (s) => completeBudgetMigration(s, 200),
    after: (_, results, at) => activated(results, at),
  });
  const first = await witness();
  await completeBudgetMigration(db, 300);
  equal(await witness(), first, 'a repeated activation keeps the witness');
  const replaced = BUDGET_INDEXES[0];
  await db.prepare(`DROP INDEX ${replaced.name}`).run();
  await db.prepare(`CREATE INDEX ${replaced.name} ON ${replaced.table}(${replaced.columns})${replaced.suffix}`).run();
  check(await catalogue() !== first[0], 'replacing an index gives it a new catalogue row');
  const racing = await lockstep(db, (s) => completeBudgetMigration(s, 0), (s) => completeBudgetMigration(s, 1));
  check(racing.every((result) => result.active === true), 'racing activations over a replaced index both answer active');
  equal(await witness(), [await catalogue()], 'the witness names the replacement catalogue despite a rolled-back clock');
  await db.prepare(`DROP INDEX ${replaced.name}`).run();
  await db.prepare(`CREATE INDEX ${replaced.name} ON ${replaced.table}(settled_seq)`).run();
  const kept = await witness();
  let refusal: unknown;
  try { await completeBudgetMigration(db, 3); } catch (error) { refusal = error; }
  check(refusal instanceof Error && refusal.message === 'Active budget indexes do not match the admitted schema', 'an index with another definition refuses activation');
  equal(await witness(), kept, 'a refused activation keeps the witness it had');
};

const backupPruneRaces = async (db: RelationalStore): Promise<void> => {
  const failed: BackupPruneOutcome = { state: 'failed', errorClass: 'storage' };
  const finished: BackupPruneOutcome = { state: 'pruned', pruned: 2, deferred: 0 };
  const deferred: BackupPruneOutcome = { state: 'deferred', reason: 'building' };
  const whole = async (at: string) => {
    const status = await backupPruneStatus(db);
    const expected = status?.outcome.state === 'failed' ? { at: 100, outcome: failed, lastFailure: { at: 100, errorClass: 'storage' } } : { at: 200, outcome: finished };
    equal(status, expected, `of two racing prune passes, the one recorded last is the status, whole, and a finished pass clears the failure (${at})`);
  };
  for (const order of [0, 1]) {
    // The writer passed second records last.
    if (order === 0) await lockstep(db, (s) => recordBackupPrune(s, 100, failed), (s) => recordBackupPrune(s, 200, finished));
    else await lockstep(db, (s) => recordBackupPrune(s, 200, finished), (s) => recordBackupPrune(s, 100, failed));
    equal((await backupPruneStatus(db))?.outcome.state, order === 0 ? 'pruned' : 'failed', 'the prune pass recorded last is the status');
    await whole(`alternating, order ${order}`);
  }
  await sweep(db, {
    left: () => (s) => recordBackupPrune(s, 100, failed),
    right: () => (s) => recordBackupPrune(s, 200, finished),
    after: (_, __, at) => whole(at),
  });
  const failureKept = async (at: string) =>
    equal((await backupPruneStatus(db))?.lastFailure, { at: 400, errorClass: 'storage' }, `a failure racing an unfinished pass is kept, whichever records last (${at})`);
  for (const order of [0, 1]) {
    await recordBackupPrune(db, 300, finished);
    if (order === 0) await lockstep(db, (s) => recordBackupPrune(s, 400, failed), (s) => recordBackupPrune(s, 500, deferred));
    else await lockstep(db, (s) => recordBackupPrune(s, 500, deferred), (s) => recordBackupPrune(s, 400, failed));
    await failureKept(`alternating, order ${order}`);
  }
  await sweep(db, {
    before: async () => { await recordBackupPrune(db, 300, finished); },
    left: () => (s) => recordBackupPrune(s, 400, failed),
    right: () => (s) => recordBackupPrune(s, 500, deferred),
    after: (_, __, at) => failureKept(at),
  });
};

const requestStampRaces = async (db: RelationalStore): Promise<void> => {
  const apart = 2 * REQUEST_STAMP_INTERVAL_MS;
  for (const [earlier, later] of [[apart, 2 * apart], [4 * apart, 3 * apart]] as const) {
    await lockstep(db, (s) => stampRequest(s, earlier), (s) => stampRequest(s, later));
    equal(await lastActivityAt(db), Math.max(earlier, later), 'of two racing request stamps a stamp interval apart, the later instant is kept, whichever commits first');
  }
  const before = await lastActivityAt(db);
  await lockstep(db, (s) => stampRequest(s, apart), (s) => stampRequest(s, 2 * apart));
  equal(await lastActivityAt(db), before, 'racing stamps older than the kept one never move it backwards');
};

const maintenanceClaimRaces = async (db: RelationalStore): Promise<void> => {
  const record = (check: MaintenanceOutcome['check'], runId: string): MaintenanceOutcome => ({ runId, check, trigger: 'schedule', state: 'running', startedAt: 100,
    claimExpiresAt: 10_000, holder: null, finishedAt: null, errorClass: null, findings: [], findingsOmitted: 0, measurements: [], powerState: null });
  const claim = (check: MaintenanceOutcome['check'], runId: string) => (s: RelationalStore) => claimMaintenanceOutcome(s, record(check, runId), { bounded: true, claimedAt: 100, notBefore: null });
  for (const [order, results] of (await bothOrders(db, (o) => claim(o === 0 ? 'optimize' : 'integrity', 'first'), (o) => claim(o === 0 ? 'optimize' : 'integrity', 'second'))).entries()) {
    equal(results.filter(Boolean).length, 1, 'exactly one of two racing maintenance runs holds the check');
    const held = await maintenanceOutcomeText(db, order === 0 ? 'optimize' : 'integrity');
    equal(JSON.parse(held!).runId, results[0] ? 'first' : 'second', 'the check\'s record is the run that holds it');
  }
};

const learningSourceRepairRaces = async (db: RelationalStore): Promise<void> => {
  check(await createProject(db, PROJECT, 'Project', 0), 'the repair Project is created');
  const sessions = ['s1', 's2', 's3'];
  for (const [i, session] of sessions.entries()) {
    await db.batch([
      db.prepare("INSERT INTO session_documents(project_id,session_id,state,updated_at,last_record_at) VALUES (?1,?2,'live',0,?3)").bind(PROJECT, session, 1000 + i),
      db.prepare('INSERT INTO turn_cards(project_id,session_id,turn_key,created_at) VALUES (?1,?2,?3,0)').bind(PROJECT, session, `turn-${i}`),
      db.prepare('INSERT INTO learning_sessions(project_id,session_id) VALUES (?1,?2)').bind(PROJECT, session),
    ]);
  }
  const stamps = async () => [
    ...await rows<{ session_id: string; at: number | null }>(db, 'SELECT session_id,source_activity_at AS at FROM turn_cards ORDER BY session_id'),
    ...await rows<{ session_id: string; at: number | null }>(db, 'SELECT session_id,source_activity_at AS at FROM learning_sessions ORDER BY session_id'),
  ];
  const expected = [...sessions, ...sessions].map((session) => ({ session_id: session, at: 1000 + sessions.indexOf(session) }));
  // Rows without a source stamp, as older writers left them.
  const unstamped = async () => { await db.batch([db.prepare('UPDATE turn_cards SET source_activity_at=NULL'), db.prepare('UPDATE learning_sessions SET source_activity_at=NULL')]); };
  const once = async (wakes: Array<{ changed: number }>, at: string) => {
    equal(await stamps(), expected, `two racing repair wakes stamp every row with its session's source instant (${at})`);
    equal(wakes[0]!.changed + wakes[1]!.changed, expected.length, `two racing repair wakes stamp each row once between them (${at})`);
  };
  await unstamped();
  await once(await lockstep(db, repairLearningSources, repairLearningSources), 'alternating');
  await sweep(db, { before: unstamped, left: () => repairLearningSources, right: () => repairLearningSources, after: (_, wakes, at) => once(wakes, at) });
};

export const DEPLOYMENT_META_RACES: Record<string, (db: RelationalStore) => Promise<void>> = {
  'racing budget activations leave one active governor whose witness names the current index catalogue': budgetActivationRaces,
  ...ESTIMATE_RACES,
  'racing backup prune passes leave one whole status and never drop an unresolved failure': backupPruneRaces,
  'racing request stamps a stamp interval apart keep the later instant and never move backwards': requestStampRaces,
  'racing maintenance runs leave exactly one holding the check': maintenanceClaimRaces,
  'racing learning source repairs stamp every row once': learningSourceRepairRaces,
};
