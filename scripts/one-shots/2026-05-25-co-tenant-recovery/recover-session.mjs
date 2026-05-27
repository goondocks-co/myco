// ONE-SHOT RECOVERY — see README.md in this directory. Hardcoded for
// the developer's machine. Refuses to run anywhere else.
import { Database } from 'bun:sqlite';
import os from 'node:os';
import fs from 'node:fs';
const DB_PATH = '/Users/chris/.myco/groves/grove_b7e9d7eb502816dafb8ae9eebe5bfa25/myco.db';
const SESSION_ID = '90f7ca3f-9835-47b6-803a-1ec82316dc13';
if (os.userInfo().username !== 'chris' || !fs.existsSync(DB_PATH)) {
  console.error('This is a one-shot recovery script hardcoded for the original developer machine.');
  console.error(`Expected user=chris and DB at ${DB_PATH}; got user=${os.userInfo().username}.`);
  console.error('See ./README.md. Do not modify paths to "generalize" — see the structural fix instead.');
  process.exit(1);
}
// Cross-checks that the session and batch row also exist before we
// touch anything. If a future-Chris cleans state and accidentally
// runs this, the script no-ops rather than corrupting a healthy DB.
const APPLY = process.argv.includes('--apply');
const db = new Database(DB_PATH);
const sanityCheck = db.prepare('SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id=?').get(SESSION_ID).n;
if (sanityCheck === 0) {
  console.log('Session not present in DB — nothing to recover. Exiting.');
  process.exit(0);
}
console.log(`mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const before = {
  batches: db.prepare('SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id=?').get(SESSION_ID).n,
  activities: db.prepare('SELECT COUNT(*) AS n FROM activities WHERE session_id=?').get(SESSION_ID).n,
  uniqueBatches: db.prepare("SELECT COUNT(DISTINCT user_prompt||'|'||origin) AS n FROM prompt_batches WHERE session_id=?").get(SESSION_ID).n,
};
console.log('before:', before);

db.prepare('BEGIN').run();

try {
  db.prepare(`CREATE TEMP TABLE canonical AS
    SELECT MIN(id) AS canonical_id, user_prompt, origin
    FROM prompt_batches WHERE session_id = ?
    GROUP BY user_prompt, origin`).run(SESSION_ID);

  const canonicalCount = db.prepare('SELECT COUNT(*) AS n FROM canonical').get().n;
  console.log(`canonical batches: ${canonicalCount}`);

  db.prepare(`CREATE TEMP TABLE dup_map AS
    SELECT pb.id AS dup_id, c.canonical_id FROM prompt_batches pb
    JOIN canonical c ON c.user_prompt = pb.user_prompt AND c.origin = pb.origin
    WHERE pb.session_id = ? AND pb.id != c.canonical_id`).run(SESSION_ID);
  const dupCount = db.prepare('SELECT COUNT(*) AS n FROM dup_map').get().n;
  console.log(`duplicate batches to delete: ${dupCount}`);

  const lifted = db.prepare(`UPDATE prompt_batches
    SET response_summary = (SELECT response_summary FROM prompt_batches d
      WHERE d.session_id = prompt_batches.session_id
        AND d.user_prompt = prompt_batches.user_prompt
        AND d.origin = prompt_batches.origin
        AND d.id != prompt_batches.id
        AND d.response_summary IS NOT NULL
      ORDER BY d.id ASC LIMIT 1)
    WHERE id IN (SELECT canonical_id FROM canonical)
      AND response_summary IS NULL
      AND EXISTS (SELECT 1 FROM prompt_batches d
        WHERE d.session_id = prompt_batches.session_id
          AND d.user_prompt = prompt_batches.user_prompt
          AND d.origin = prompt_batches.origin
          AND d.id != prompt_batches.id
          AND d.response_summary IS NOT NULL)`).run();
  console.log(`response_summary lifted onto canonical: ${lifted.changes}`);

  const repointed = db.prepare(`UPDATE activities
    SET prompt_batch_id = (SELECT canonical_id FROM dup_map WHERE dup_id = activities.prompt_batch_id)
    WHERE session_id = ? AND prompt_batch_id IN (SELECT dup_id FROM dup_map)`).run(SESSION_ID);
  console.log(`activities repointed: ${repointed.changes}`);

  // Dedup by (prompt_batch_id, tool_name, tool_input). content_hash is
  // null for 96% of tool-use activities so it can't be the key. The
  // (batch, tool, input) triple collapses the reconciler-injected
  // duplicates (same tool, same args, repointed to canonical batch)
  // while preserving every activity with a distinct input. The only
  // loss is the rare case of the agent making the same tool call twice
  // within one turn — acceptable for the recovery.
  const actDeleted = db.prepare(`DELETE FROM activities
    WHERE session_id = ?
      AND id NOT IN (SELECT MIN(id) FROM activities
        WHERE session_id = ?
        GROUP BY prompt_batch_id, tool_name, COALESCE(tool_input,''))`).run(SESSION_ID, SESSION_ID);
  console.log(`duplicate activities deleted: ${actDeleted.changes}`);

  const batchDeleted = db.prepare(`DELETE FROM prompt_batches WHERE id IN (SELECT dup_id FROM dup_map)`).run();
  console.log(`duplicate batches deleted: ${batchDeleted.changes}`);

  db.prepare(`CREATE TEMP TABLE renumber AS
    SELECT id, ROW_NUMBER() OVER (ORDER BY id ASC) AS new_pn
    FROM prompt_batches WHERE session_id = ?`).run(SESSION_ID);
  // Stage prompt_numbers at -id (guaranteed unique because id is the
  // primary key) so any UNIQUE (session_id, prompt_number) index does
  // not collide mid-update if the corruption itself produced duplicate
  // prompt_numbers in the same session.
  db.prepare(`UPDATE prompt_batches SET prompt_number = -id WHERE session_id = ?`).run(SESSION_ID);
  const renum = db.prepare(`UPDATE prompt_batches
    SET prompt_number = (SELECT new_pn FROM renumber WHERE renumber.id = prompt_batches.id)
    WHERE session_id = ?`).run(SESSION_ID);
  console.log(`prompt_numbers renumbered: ${renum.changes}`);

  const after = {
    batches: db.prepare('SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id=?').get(SESSION_ID).n,
    activities: db.prepare('SELECT COUNT(*) AS n FROM activities WHERE session_id=?').get(SESSION_ID).n,
    withSummary: db.prepare('SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id=? AND response_summary IS NOT NULL').get(SESSION_ID).n,
    pnMax: db.prepare('SELECT MAX(prompt_number) AS n FROM prompt_batches WHERE session_id=?').get(SESSION_ID).n,
    pnContiguous: db.prepare(`SELECT (MAX(prompt_number) - MIN(prompt_number) + 1) = COUNT(*) AS ok
      FROM prompt_batches WHERE session_id=?`).get(SESSION_ID).ok,
  };
  console.log('after :', after);

  if (after.batches !== before.uniqueBatches) throw new Error('batch count mismatch');
  if (!after.pnContiguous) throw new Error('pn not contiguous');

  if (APPLY) { db.prepare('COMMIT').run(); console.log('COMMITTED'); }
  else { db.prepare('ROLLBACK').run(); console.log('rolled back (dry-run)'); }
} catch (err) {
  db.prepare('ROLLBACK').run();
  console.error('rolled back due to error:', err.message);
  process.exitCode = 1;
}
