import type { RelationalStore } from '../../core/adapters.js';
import type { SporeInsert } from '../../core/spores.js';
import type { CurationAnswer } from '../../core/spore-curation-contract.js';
import { CURATION_ANSWER_ATTEMPTS } from '../../core/spore-curation-contract.js';
import { assertion, commitNamed, first, read, refusalCode, refusalDetail, rows, write } from '../index.js';
import { sporeInsertWrite } from './records.js';
import { curationDecisionSql } from './curation-consideration.js';
import { curationAnswerHistory } from './curation-history.js';
import { curationCloseWrites, type CurationMember, type CurationWork } from './curation-work.js';

const ANSWER_CHANGED = refusalCode('curation_answer_changed');
export const curationAnswerChanged = (error: unknown): string | null => refusalDetail(error, ANSWER_CHANGED);
type AssignmentSlots = [project: string, run: string, key: string, members: string, submission: number];
const admitted = assertion<AssignmentSlots>({
  name: 'curationAnswer.admitted', refusal: ANSWER_CHANGED,
  with: `WITH held AS (SELECT json_extract(j.value,'$.id') AS id,json_extract(j.value,'$.revision') AS expected,s.status,s.revision
    FROM json_each(?4) j LEFT JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id'))`,
  when: `NOT EXISTS (SELECT 1 FROM held WHERE status IS NULL OR status<>'active' OR revision<>expected)
    AND EXISTS (SELECT 1 FROM spore_curation_work w JOIN agent_runs r ON r.project_id=w.project_id AND r.id=?2
      WHERE w.project_id=?1 AND w.cluster_key=?3 AND w.decision IS NULL AND (w.run_id=?2 OR r.dry_run=1))
    AND EXISTS (SELECT 1 FROM spore_curation_answers WHERE project_id=?1 AND run_id=?2 AND cluster_key=?3 AND submissions=?5 AND answer IS NULL)`,
  detail: `COALESCE((SELECT 'spore '||id||' is '||COALESCE(status,'missing')||' at revision '||COALESCE(revision,-1)||'; offered revision '||expected FROM held
    WHERE status IS NULL OR status<>'active' OR revision<>expected LIMIT 1),'assignment closed or submission superseded')`,
});
const reserve = write<[project: string, run: string, key: string, limit: number], { submissions: number }>({
  name: 'curationAnswer.reserve',
  sql: `INSERT INTO spore_curation_answers(project_id,run_id,cluster_key,submissions) VALUES(?1,?2,?3,1)
    ON CONFLICT(project_id,run_id) DO UPDATE SET submissions=submissions+1
    WHERE cluster_key=?3 AND answer IS NULL AND submissions<?4 RETURNING submissions`,
});
export const reserveCurationAnswer = (db: RelationalStore, project: string, run: string, key: string) =>
  first(db, reserve.bind(project, run, key, CURATION_ANSWER_ATTEMPTS));

const considered = write<[project: string, members: string, outcome: string, at: number]>({
  name: 'curationAnswer.considered',
  sql: `INSERT INTO spore_curation_considerations(project_id,spore_id,revision,outcome,considered_at)
    SELECT ?1,s.id,s.revision,?3,?4 FROM json_each(?2) j CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id')
    WHERE s.revision=json_extract(j.value,'$.revision')
    ON CONFLICT(project_id,spore_id) DO UPDATE SET revision=excluded.revision,outcome=excluded.outcome,considered_at=excluded.considered_at
    WHERE spore_curation_considerations.revision<>excluded.revision OR ${curationDecisionSql('excluded')} OR NOT (${curationDecisionSql('spore_curation_considerations')})`,
});
interface Considered { project: string; members: readonly CurationMember[]; outcome: string; at: number }
export const curationConsiderationWrite = (options: Considered) => considered.bind(options.project, JSON.stringify(options.members), options.outcome, options.at);
export const recordCurationConsidered = (db: RelationalStore, options: Considered) => rows(db, curationConsiderationWrite(options));

const insertEvent = write<[project: string, event: string, agent: string, source: string, target: string | null, action: string, reason: string, run: string, at: number]>({
  name: 'curationAnswer.lineage',
  sql: `INSERT INTO resolution_events(project_id,id,agent_id,spore_id,new_spore_id,action,reason,author,created_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
});
const move = write<[project: string, id: string, revision: number, status: string, at: number]>({
  name: 'curationAnswer.move',
  sql: "UPDATE spores SET status=?4,revision=revision+1,updated_at=?5 WHERE project_id=?1 AND id=?2 AND revision=?3 AND status='active'",
});
const reviewOutputs = write<[project: string, key: string, members: string]>({
  name: 'curationAnswer.reviewOutputs',
  sql: `INSERT INTO spore_curation_receipts(project_id,spore_id,revision,cluster_key)
    SELECT ?1,json_extract(value,'$.id'),json_extract(value,'$.revision'),?2 FROM json_each(?3) WHERE 1
    ON CONFLICT(project_id,spore_id) DO UPDATE SET revision=excluded.revision,cluster_key=excluded.cluster_key`,
});
const save = write<[project: string, run: string, key: string, answer: string, applied: number, submission: number]>({
  name: 'curationAnswer.save',
  sql: 'UPDATE spore_curation_answers SET answer=?4,applied=?5 WHERE project_id=?1 AND run_id=?2 AND cluster_key=?3 AND submissions=?6 AND answer IS NULL',
});
export interface CheckedCuration {
  group: string;
  members: readonly CurationMember[];
  answer: CurationAnswer;
  notes: readonly SporeInsert[];
}
export async function commitCurationAnswer(db: RelationalStore, options: {
  project: string; run: string; agent: string; work: CurationWork; checked: CheckedCuration; submission: number; dryRun: boolean; now: number;
}): Promise<void> {
  const { project, run, agent, work, checked, submission, dryRun, now } = options;
  const encoded = JSON.stringify(checked.members);
  const replaced = new Map<string, string[]>();
  for (const [index, note] of checked.answer.notes.entries())
    for (const source of note.sources) replaced.set(source, [...(replaced.get(source) ?? []), checked.notes[index]!.id]);
  const retired = new Map(checked.answer.retire.map(item => [item.id, item]));
  const changed = checked.members.filter(member => replaced.has(member.id) || retired.has(member.id));
  const outputs = checked.notes.map(note => ({ id: note.id, revision: 0 }));
  const events = changed.flatMap(member => {
    const retiredNote = retired.get(member.id);
    const targets = replaced.get(member.id) ?? [null];
    return targets.map(target => insertEvent.bind(project, crypto.randomUUID(), agent, member.id, target, target === null ? 'obsolete' : 'consolidate',
      retiredNote === undefined ? checked.answer.reason : `${retiredNote.reason} Made unnecessary by ${(retiredNote.made_unnecessary_by.startsWith('new:') ? checked.notes[Number(retiredNote.made_unnecessary_by.slice(4))]!.id : retiredNote.made_unnecessary_by)}.`, run, now));
  });
  await commitNamed(db, {
    admitted: admitted.bind(project, run, checked.group, encoded, submission),
    notes: dryRun ? [] : checked.notes.map(note => sporeInsertWrite({ projectId: project }, note)),
    history: dryRun ? [] : curationAnswerHistory({ project, run, group: checked.group, now, answer: checked.answer, outputs: checked.notes.map(note=>note.id) }),
    events: dryRun ? [] : events,
    considerations: dryRun ? [] : [
      considered.bind(project, encoded, 'reviewed', now),
      considered.bind(project, JSON.stringify(outputs), 'curated', now),
    ],
    outputs: dryRun ? [] : [reviewOutputs.bind(project, checked.group, JSON.stringify(outputs))],
    moves: dryRun ? [] : changed.map(member => move.bind(project, member.id, member.revision, retired.has(member.id) ? 'obsolete' : 'consolidated', now)),
    saved: save.bind(project, run, checked.group, JSON.stringify(checked), dryRun ? 0 : 1, submission),
    ...(dryRun ? {} : curationCloseWrites({ projectId: project, work, decision: changed.length === 0 ? 'keep' : 'resolved', reason: checked.answer.reason, now, reviewed: checked.members })),
  });
}
const answer = read<[project: string, run: string], { cluster_key: string; submissions: number; answer: string | null; applied: number }>({
  name: 'curationAnswer.answer', sql: 'SELECT cluster_key,submissions,answer,applied FROM spore_curation_answers WHERE project_id=?1 AND run_id=?2',
});
export const readCurationAnswer = (db: RelationalStore, project: string, run: string) => first(db, answer.bind(project, run));
const coverage = read<[project: string], { unconsidered: number; unevaluated: number }>({ name: 'curationAnswer.coverage', sql: 'SELECT unconsidered,unevaluated FROM spore_curation_coverage WHERE project_id=?1' });
export const readCurationCoverage = async (db: RelationalStore, project: string) => await first(db, coverage.bind(project)) ?? { unconsidered: 0, unevaluated: 0 };
export const curationAnswerPresent = async (db: RelationalStore, scope: { projectId: string }, run: { id: string }): Promise<boolean> =>
  (await readCurationAnswer(db, scope.projectId, run.id))?.answer != null;
