import { curationDecisionSql } from './spores/curation-consideration.js';
import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_CURATION_ANSWER } from './schema-vNEXT-curation-answer.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

const atRevision = (row: string, outcome: 'decision' | 'unevaluated') => `EXISTS (SELECT 1 FROM spore_curation_considerations c WHERE c.project_id=${row}.project_id AND c.spore_id=${row}.id AND c.revision=${row}.revision AND ${outcome === 'decision' ? curationDecisionSql('c') : `NOT (${curationDecisionSql('c')})`})`;
const unknown = (row: string) => `(${row}.status='active' AND NOT (${atRevision(row, 'decision')}))`;
const unevaluated = (row: string) => `(${row}.status='active' AND ${atRevision(row, 'unevaluated')})`;
const adjust = (project: string, unconsidered: string, unevaluated: string) => `INSERT INTO spore_curation_coverage(project_id,unconsidered,unevaluated) VALUES(${project},${unconsidered},${unevaluated})
  ON CONFLICT(project_id) DO UPDATE SET unconsidered=unconsidered+excluded.unconsidered,unevaluated=unevaluated+excluded.unevaluated;`;
const adoptReview = (project: string, id: string) => `INSERT INTO spore_curation_considerations(project_id,spore_id,revision,outcome,considered_at)
  SELECT s.project_id,s.id,s.revision,'reviewed',COALESCE(w.decided_at,0) FROM spore_curation_receipts r
    JOIN spores s ON s.project_id=r.project_id AND s.id=r.spore_id AND s.revision=r.revision
    JOIN spore_curation_work w ON w.project_id=r.project_id AND w.cluster_key=r.cluster_key
  WHERE r.project_id=${project} AND r.spore_id=${id}
  ON CONFLICT(project_id,spore_id) DO UPDATE SET revision=excluded.revision,outcome=excluded.outcome,considered_at=excluded.considered_at
    WHERE spore_curation_considerations.revision<>excluded.revision OR NOT (${curationDecisionSql('spore_curation_considerations')});`;
const receiptActive = (row: string) => `EXISTS (SELECT 1 FROM spores s WHERE s.project_id=${row}.project_id AND s.id=${row}.spore_id AND s.status='active' AND s.revision=${row}.revision)`;

const receiptDecision = (row: string) => `(${receiptActive(row)} AND ${curationDecisionSql(row)})`;
const receiptUnevaluated = (row: string) => `(${receiptActive(row)} AND NOT (${curationDecisionSql(row)}))`;

/** Coverage counts current decisions and deferred evaluations per Project. */
export const CURATION_ANSWER_STEPS: readonly SchemaStep[] = [{
  version: NEXT_CURATION_ANSWER,
  statements: [
    'ALTER TABLE spores ADD COLUMN observed_at INTEGER',
    `CREATE TABLE IF NOT EXISTS spore_curation_answers(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), run_id TEXT NOT NULL,
      cluster_key TEXT NOT NULL, submissions INTEGER NOT NULL DEFAULT 0, answer TEXT CHECK(answer IS NULL OR json_valid(answer)),
      applied INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,run_id),
      FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS spore_curation_considerations(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),spore_id TEXT NOT NULL,
      revision INTEGER NOT NULL,outcome TEXT NOT NULL,considered_at INTEGER NOT NULL,PRIMARY KEY(project_id,spore_id),
      FOREIGN KEY(project_id,spore_id) REFERENCES spores(project_id,id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS spore_curation_coverage(project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id) ON DELETE CASCADE,
      unconsidered INTEGER NOT NULL,unevaluated INTEGER NOT NULL)`,
    `INSERT INTO spore_curation_considerations(project_id,spore_id,revision,outcome,considered_at)
      SELECT r.project_id,r.spore_id,r.revision,'reviewed',COALESCE(w.decided_at,0) FROM spore_curation_receipts r
      JOIN spores s ON s.project_id=r.project_id AND s.id=r.spore_id
      JOIN spore_curation_work w ON w.project_id=r.project_id AND w.cluster_key=r.cluster_key WHERE 1
      ON CONFLICT(project_id,spore_id) DO NOTHING`,
    `INSERT INTO spore_curation_coverage(project_id,unconsidered,unevaluated)
      SELECT p.project_id,(SELECT COUNT(*) FROM spores s WHERE s.project_id=p.project_id AND ${unknown('s')}),
        (SELECT COUNT(*) FROM spores s WHERE s.project_id=p.project_id AND ${unevaluated('s')}) FROM projects p WHERE 1
      ON CONFLICT(project_id) DO UPDATE SET unconsidered=excluded.unconsidered,unevaluated=excluded.unevaluated`,
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_spore_insert AFTER INSERT ON spores BEGIN ${adjust('NEW.project_id', unknown('NEW'), unevaluated('NEW'))} ${adoptReview('NEW.project_id','NEW.id')} END`,
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_spore_update AFTER UPDATE OF status,revision ON spores BEGIN ${adjust('NEW.project_id', `${unknown('NEW')}-${unknown('OLD')}`, `${unevaluated('NEW')}-${unevaluated('OLD')}`)} END`,
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_spore_delete BEFORE DELETE ON spores BEGIN ${adjust('OLD.project_id', `-${unknown('OLD')}`, `-${unevaluated('OLD')}`)} END`,
    ...['INSERT','UPDATE'].map(operation => `CREATE TRIGGER IF NOT EXISTS curation_coverage_review_${operation.toLowerCase()} AFTER ${operation} ON spore_curation_receipts BEGIN ${adoptReview('NEW.project_id','NEW.spore_id')} END`),
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_considered_insert AFTER INSERT ON spore_curation_considerations BEGIN ${adjust('NEW.project_id', `-${receiptDecision('NEW')}`, receiptUnevaluated('NEW'))} END`,
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_considered_update AFTER UPDATE ON spore_curation_considerations BEGIN ${adjust('NEW.project_id', `${receiptDecision('OLD')}-${receiptDecision('NEW')}`, `${receiptUnevaluated('NEW')}-${receiptUnevaluated('OLD')}`)} END`,
    `CREATE TRIGGER IF NOT EXISTS curation_coverage_considered_delete AFTER DELETE ON spore_curation_considerations BEGIN ${adjust('OLD.project_id', receiptDecision('OLD'), `-${receiptUnevaluated('OLD')}`)} END`,
  ],
  reaches: [
    ...changing(['spores'], 'New curated notes carry their source observation date explicitly; existing rows retain a null date.'),
    ...reaching(['spore_curation_receipts'], 'Review receipt triggers rebuild their current consideration and coverage.'),
  ],
}];
