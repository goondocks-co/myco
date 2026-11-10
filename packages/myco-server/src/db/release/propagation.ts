import type { RelationalStore } from '../../core/adapters.js';
import { jsonKeys } from '../ddl.js';
import { assertion, commitNamed, read, refusalCode, refused, rows, write } from '../index.js';
import { RELEASE_WRITE_COLUMNS, RELEASE_UPSERT } from './classification.js';

/** Records one pass carries for one session; a longer session continues on a later pass. */
export const RELEASE_PROPAGATION_PAGE = 50;
const SESSIONS_PER_PASS = 20;

const MOVED = refusalCode('release_propagation_moved');

interface Due { project_id: string; session_id: string; generation: number; after_namespace: string; after_record: string }

const dueHead = read<[limit: number], Due>({ name: 'releasePropagation.head', sql:
  'SELECT project_id,session_id,generation,after_namespace,after_record FROM release_propagation_due ORDER BY queued_at,project_id,session_id LIMIT ?1' });

/** A session's plans, by key: a session holds few, so their sort is small. */
const plansPage = read<[project: string, session: string, after: string, limit: number], { rec: string }>({ name: 'releasePropagation.plans', sql:
  'SELECT plan_key AS rec FROM plans WHERE project_id=?1 AND session_id=?2 AND plan_key>?3 ORDER BY plan_key LIMIT ?4' });
/** A session's spores in the order of their session index, so a page reads only its own rows. */
const sporesPage = read<[project: string, session: string, afterAt: number, afterId: string, limit: number], { rec: string; createdAt: number }>({ name: 'releasePropagation.spores', sql:
  `SELECT id AS rec,created_at AS createdAt FROM spores INDEXED BY idx_spores_session WHERE project_id=?1 AND session_id=?2 AND (created_at,id)>(?3,?4)
   ORDER BY created_at,id LIMIT ?5` });

interface PageKey { ns: 'plans' | 'spores'; rec: string; cursor: string }

/** The next page of a session's records after its cursor: plans first, then spores. */
async function derivedPage(db: RelationalStore, row: Due, limit: number): Promise<PageKey[]> {
  const keys: PageKey[] = [];
  if (row.after_namespace !== 'spores') {
    for (const plan of await rows(db, plansPage.bind(row.project_id, row.session_id, row.after_namespace === 'plans' ? row.after_record : '', limit))) {
      keys.push({ ns: 'plans', rec: plan.rec, cursor: plan.rec });
    }
  }
  if (keys.length < limit) {
    const [afterAt, afterId] = row.after_namespace === 'spores' ? JSON.parse(row.after_record) as [number, string] : [Number.MIN_SAFE_INTEGER, ''];
    for (const spore of await rows(db, sporesPage.bind(row.project_id, row.session_id, afterAt, afterId, limit - keys.length))) {
      keys.push({ ns: 'spores', rec: spore.rec, cursor: JSON.stringify([spore.createdAt, spore.rec]) });
    }
  }
  return keys;
}

const held = assertion<[project: string, session: string, generation: number]>({ name: 'releasePropagation.held', refusal: MOVED,
  when: 'EXISTS (SELECT 1 FROM release_propagation_due WHERE project_id=?1 AND session_id=?2 AND generation=?3)' });

const pageKeys = `(${jsonKeys(['ns', 'rec'])})`;
const copy = write<[keys: string, project: string, session: string, now: number]>({ name: 'releasePropagation.copy', sql:
  `INSERT INTO knowledge_release_state ${RELEASE_WRITE_COLUMNS}
   SELECT k.project_id,'rs_'||lower(hex(randomblob(16))),k.project_id||':'||j.ns||':'||j.rec,j.ns,j.rec,?3,k.state,k.confidence,k.basis_kind,k.basis_ref,k.basis_sha,k.release_pr_number,k.reason,
     CASE WHEN json_valid(k.evidence_json) THEN json_remove(k.evidence_json,'$.previous') END,k.checked_at,?4,k.source_key,k.config_revision,k.refs_fingerprint,k.paths_mark,1
   FROM ${pageKeys} j JOIN knowledge_release_state k ON k.project_id=?2 AND k.identity_key=?2||':sessions:'||?3 WHERE true
   ${RELEASE_UPSERT}` });

const advance = write<[project: string, session: string, generation: number, afterNamespace: string, afterRecord: string, now: number], { project_id: string }>({ name: 'releasePropagation.advance', sql:
  'UPDATE release_propagation_due SET after_namespace=?4,after_record=?5,queued_at=?6 WHERE project_id=?1 AND session_id=?2 AND generation=?3 RETURNING project_id' });
const finish = write<[project: string, session: string, generation: number], { project_id: string }>({ name: 'releasePropagation.finish', sql:
  'DELETE FROM release_propagation_due WHERE project_id=?1 AND session_id=?2 AND generation=?3 RETURNING project_id' });

/**
 * One bounded pass over the queue: at most one page per due session; a long session continues on a later pass after
 * others take a turn. Answers the records carried, and whether the queue still holds work for another pass.
 */
export async function drainReleasePropagation(db: RelationalStore, now: number): Promise<{ copied: number; more: boolean }> {
  const due = await rows(db, dueHead.bind(SESSIONS_PER_PASS + 1));
  let copied = 0;
  for (const row of due.slice(0, SESSIONS_PER_PASS)) {
    const page = await derivedPage(db, row, RELEASE_PROPAGATION_PAGE + 1);
    const kept = page.slice(0, RELEASE_PROPAGATION_PAGE);
    const last = kept.at(-1);
    const more = page.length > RELEASE_PROPAGATION_PAGE && last !== undefined;
    try {
      await commitNamed(db, {
        held: held.bind(row.project_id, row.session_id, row.generation),
        copied: copy.bind(JSON.stringify(kept.map(k => [k.ns, k.rec])), row.project_id, row.session_id, now),
        settled: more
          ? advance.bind(row.project_id, row.session_id, row.generation, last.ns, last.cursor, now)
          : finish.bind(row.project_id, row.session_id, row.generation),
      });
      copied += kept.length;
    } catch (error) {
      if (!refused(error, MOVED)) throw error;
    }
  }
  return { copied, more: due.length > SESSIONS_PER_PASS || (await rows(db, dueHead.bind(1))).length > 0 };
}
