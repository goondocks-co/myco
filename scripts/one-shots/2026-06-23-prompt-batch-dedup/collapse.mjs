// ONE-SHOT — see README.md in this directory. Collapses the historical
// byte-identical prompt_batch duplicates left by the re-mine overlap bug
// (the going-forward guard is the content_hash UNIQUE index activated in
// packages/myco/src/db/queries/batches.ts). Hardcoded to the original
// developer machine; refuses to run elsewhere. DRY-RUN unless --apply.
//
// Usage:
//   bun scripts/one-shots/2026-06-23-prompt-batch-dedup/collapse.mjs            # dry-run, all groves
//   bun scripts/one-shots/2026-06-23-prompt-batch-dedup/collapse.mjs --db PATH  # dry-run, one DB
//   bun scripts/one-shots/2026-06-23-prompt-batch-dedup/collapse.mjs --apply    # COMMIT
import { Database } from 'bun:sqlite';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

if (os.userInfo().username !== 'chris') {
  console.error('One-shot hardcoded for the original developer machine (user=chris).');
  console.error(`Got user=${os.userInfo().username}. See ./README.md — do not "generalize" this; the going-forward fix is the content_hash guard.`);
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const dbArgIdx = process.argv.indexOf('--db');
const HOME = os.homedir();

/** Collapse key MUST match the going-forward normalize (JS .trim() of the full prompt). */
const norm = (t) => (t ?? '').trim();

/** Every column that references prompt_batches(id) — repoint dup→canonical before delete. */
const CHILD_REFS = [
  { table: 'prompt_batches', col: 'parent_prompt_batch_id' },
  { table: 'activities', col: 'prompt_batch_id' },
  { table: 'knowledge_git_provenance', col: 'prompt_batch_id' },
  { table: 'knowledge_release_state', col: 'source_prompt_batch_id' },
  { table: 'plans', col: 'prompt_batch_id' },
  { table: 'attachments', col: 'prompt_batch_id' },
  { table: 'spores', col: 'prompt_batch_id' },
];

function discoverDbs() {
  if (dbArgIdx !== -1) return [process.argv[dbArgIdx + 1]];
  const roots = [path.join(HOME, '.myco', 'groves'), path.join(HOME, '.myco-dev', 'groves')];
  const dbs = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const p = path.join(root, entry, 'myco.db');
      if (fs.existsSync(p)) dbs.push(p);
    }
  }
  return dbs;
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function collapseDb(dbPath) {
  const db = new Database(dbPath);
  // The live daemon holds these DBs in WAL; wait rather than fail on its
  // transient write locks during our (rolled-back) dry-run transaction.
  db.run('PRAGMA busy_timeout = 5000');
  // FK ON so an un-repointed child reference aborts the DELETE (loud) instead
  // of silently orphaning a row — the safety net for any child table this
  // script doesn't know about.
  db.run('PRAGMA foreign_keys = ON');

  // Build the canonical map in JS so the collapse key matches the going-forward
  // JS .trim() normalization exactly (SQLite trim() only strips spaces).
  const rows = db.prepare('SELECT id, session_id, origin, user_prompt FROM prompt_batches').all();
  const groups = new Map(); // key -> sorted ids
  for (const r of rows) {
    // Same field shape as the going-forward content_hash, minus the ordinal.
    const key = [r.session_id, r.origin, norm(r.user_prompt)].join(" ");
    const list = groups.get(key) ?? [];
    list.push(r.id);
    groups.set(key, list);
  }
  const pairs = []; // { dup_id, canonical_id }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b);
    const canonical = ids[0];
    for (let i = 1; i < ids.length; i++) pairs.push({ dup_id: ids[i], canonical_id: canonical });
  }

  const before = {
    batches: rows.length,
    groups: groups.size,
    dups: pairs.length,
  };
  if (pairs.length === 0) {
    console.log(`  ${dbPath}\n    no duplicates — skipped`);
    db.close();
    return { dups: 0 };
  }

  // Conscious handling of the per-row team-delete trigger
  // (TEAM_DELETE_TRIGGERS in schema-ddl.ts): on a sync-enabled, member project
  // a mass DELETE would enqueue one team_outbox 'delete' per collapsed row —
  // the tenancy-flood shape. Suppress by flipping team_sync_state.enabled to 0
  // inside the txn (the trigger re-reads it per row), restored before COMMIT.
  // The dup rows were never legitimately distinct; D1 keeps its (inert) copies.
  const syncRow = tableExists(db, 'team_sync_state')
    ? db.prepare('SELECT enabled FROM team_sync_state LIMIT 1').get()
    : null;
  const syncWasEnabled = !!(syncRow && syncRow.enabled === 1);

  const childCountsBefore = {};
  for (const { table } of CHILD_REFS) {
    if (table === 'prompt_batches') continue;
    childCountsBefore[table] = tableExists(db, table)
      ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
      : null;
  }

  db.prepare('BEGIN').run();
  try {
    if (syncWasEnabled) db.prepare('UPDATE team_sync_state SET enabled = 0').run();

    db.run('CREATE TEMP TABLE dup_map (dup_id INTEGER PRIMARY KEY, canonical_id INTEGER NOT NULL)');
    const ins = db.prepare('INSERT INTO dup_map (dup_id, canonical_id) VALUES (?, ?)');
    for (const p of pairs) ins.run(p.dup_id, p.canonical_id);

    // Preserve a response_summary that only the dup carries.
    const lifted = db.prepare(`
      UPDATE prompt_batches SET response_summary = (
        SELECT d.response_summary FROM prompt_batches d
        JOIN dup_map m ON m.dup_id = d.id
        WHERE m.canonical_id = prompt_batches.id AND d.response_summary IS NOT NULL
        ORDER BY d.id ASC LIMIT 1)
      WHERE id IN (SELECT canonical_id FROM dup_map)
        AND response_summary IS NULL
        AND EXISTS (
          SELECT 1 FROM prompt_batches d JOIN dup_map m ON m.dup_id = d.id
          WHERE m.canonical_id = prompt_batches.id AND d.response_summary IS NOT NULL)`).run();

    // Repoint every child reference dup→canonical so the DELETE never orphans.
    let repointed = 0;
    for (const { table, col } of CHILD_REFS) {
      if (!tableExists(db, table)) continue;
      const r = db.prepare(
        `UPDATE ${table} SET ${col} = (SELECT canonical_id FROM dup_map WHERE dup_id = ${table}.${col})
         WHERE ${col} IN (SELECT dup_id FROM dup_map)`,
      ).run();
      repointed += r.changes;
    }

    const deleted = db.prepare('DELETE FROM prompt_batches WHERE id IN (SELECT dup_id FROM dup_map)').run();

    // Restore sync flag BEFORE asserting/commit.
    if (syncWasEnabled) db.prepare('UPDATE team_sync_state SET enabled = 1').run();

    const after = {
      batches: db.prepare('SELECT COUNT(*) AS n FROM prompt_batches').get().n,
    };
    // Invariants: exactly the dup rows were removed; no child rows were lost
    // (they were repointed, never deleted); no dangling parent ref remains.
    if (after.batches !== before.batches - before.dups) {
      throw new Error(`batch count mismatch: ${after.batches} != ${before.batches} - ${before.dups}`);
    }
    for (const { table } of CHILD_REFS) {
      if (table === 'prompt_batches') continue;
      if (childCountsBefore[table] === null) continue;
      const now = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      if (now !== childCountsBefore[table]) throw new Error(`${table} row count changed: ${childCountsBefore[table]} -> ${now}`);
    }
    const dangling = db.prepare(
      `SELECT COUNT(*) AS n FROM prompt_batches
       WHERE parent_prompt_batch_id IS NOT NULL
         AND parent_prompt_batch_id NOT IN (SELECT id FROM prompt_batches)`).get().n;
    if (dangling !== 0) throw new Error(`${dangling} dangling parent_prompt_batch_id refs after collapse`);

    console.log(`  ${dbPath}`);
    console.log(`    batches ${before.batches} -> ${after.batches}  (collapsed ${before.dups} dups across ${before.groups} groups; summaries lifted ${lifted.changes}; child refs repointed ${repointed}; sync trigger ${syncWasEnabled ? 'SUPPRESSED' : 'inactive'})`);

    if (APPLY) { db.prepare('COMMIT').run(); console.log('    COMMITTED'); }
    else { db.prepare('ROLLBACK').run(); console.log('    rolled back (dry-run)'); }
    db.close();
    return { dups: before.dups };
  } catch (err) {
    db.prepare('ROLLBACK').run();
    db.close();
    console.error(`    rolled back due to error: ${err.message}`);
    process.exitCode = 1;
    return { dups: 0, error: true };
  }
}

console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
const dbs = discoverDbs();
if (dbs.length === 0) { console.log('no grove DBs found'); process.exit(0); }
let totalDups = 0;
for (const dbPath of dbs) {
  if (!dbPath || !fs.existsSync(dbPath)) { console.error(`  ${dbPath}: not found`); continue; }
  const { dups } = collapseDb(dbPath);
  totalDups += dups ?? 0;
}
console.log(`\ntotal duplicate batches ${APPLY ? 'collapsed' : 'collapsible'}: ${totalDups}`);
