import { write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';
import { reset } from './rebuild.js';

export const PUBLICATION_REOPEN_PHASE = 'publicationReopenAdmissionsV1';
function reopenAdmissions(revision: number) {
  const eligible = `d.state='live' AND p.state='failed' AND p.failure IN ('event_refused','record_too_large')
    AND p.reopen_revision<${revision}
    AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(p.project_id,p.session_id))`;
  const source = {
    table: `transcript_publication p INDEXED BY idx_publication_reopen JOIN session_documents d
      ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)`,
    columns: ['p.parser_version','p.project_id','p.transcript_id','p.generation'],
    where: eligible,
    pageSize: 1,
    startKey: [-1,'','',0],
  };
  const selected = `SELECT p.project_id,p.transcript_id,p.generation,p.session_id FROM json_each(?1) k
    JOIN transcript_publication p ON (p.parser_version,p.project_id,p.transcript_id,p.generation)=
      (json_extract(k.value,'$[0]'),json_extract(k.value,'$[1]'),json_extract(k.value,'$[2]'),json_extract(k.value,'$[3]'))
    JOIN session_documents d ON (d.project_id,d.session_id,d.generation)=(p.project_id,p.session_id,p.generation)
    WHERE ${eligible}`;

  return {
    source,
    reconcile: [
      write<[keys: string]>({name:`publication.armReopened${revision}`,sql:`UPDATE session_documents SET due_at=0
        WHERE (project_id,session_id,generation) IN (SELECT project_id,session_id,generation FROM (${selected}))`}),
      write<[keys: string]>({name:`publication.reopenAdmissions${revision}`,sql:`UPDATE transcript_publication AS p
        SET ${reset('p')},reopen_revision=${revision}
        WHERE (p.project_id,p.transcript_id,p.generation) IN (SELECT project_id,transcript_id,generation FROM (${selected}))`}),
    ],
  };
}

/** A publication gets one retry per admission revision, even if publishing moves its parser-version key forward. */
export const PUBLICATION_REOPEN_CATCHUP = {
  projection: 'publication_reopen',
  phases: { [PUBLICATION_REOPEN_PHASE]: reopenAdmissions(1) },
} as const satisfies CatchupFamily;

/** Seeds one bounded retry of stopped publications; subsequent admission fixes declare a new revision and phase. */
export function publicationReopenSchemaStatements(): string[] {
  const {source}=PUBLICATION_REOPEN_CATCHUP.phases[PUBLICATION_REOPEN_PHASE];
  return [
    'ALTER TABLE transcript_publication ADD COLUMN reopen_revision INTEGER NOT NULL DEFAULT 0',
    `INSERT INTO projection_catchup(projection,phase,done)
      SELECT '${PUBLICATION_REOPEN_CATCHUP.projection}','${PUBLICATION_REOPEN_PHASE}',
        NOT EXISTS(SELECT 1 FROM ${source.table} WHERE ${source.where}) ON CONFLICT DO NOTHING`,
  ];
}
