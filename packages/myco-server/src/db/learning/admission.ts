import type { RelationalStore } from '../../core/adapters.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { assertion, first, read } from '../index.js';
import { CLAIM_SELECTION_REFUSED } from '../runs/claim-refusals.js';
import { learningEnabledSql } from '../settings/admission.js';
import { learningWindowSql } from '../runs/learning-policy.js';

/** Only a person's named learning run may read beyond the automatic window. */
const admitted = (slots: { project: string; session: string; run: string; now: string }) => `EXISTS(SELECT 1 FROM learning_sessions l
  WHERE l.project_id=${slots.project} AND l.session_id=${slots.session} AND ((${learningWindowSql(slots.now)} AND ${learningEnabledSql()})
    OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=l.project_id AND r.id=${slots.run} AND r.task='${EXTRACTION_TASK}' AND r.origin='manual'
      AND CASE WHEN json_valid(r.dispatch_spec) THEN json_extract(r.dispatch_spec,'$.params.session_id') END=l.session_id)))`;
const predicate = admitted({ project: '?1', session: '?2', run: '?3', now: '?4' });
type Admission = [project: string, session: string, run: string, now: number];
const allowed = read<Admission, { allowed: number }>({ name: 'learningAdmission.run', sql: `SELECT ${predicate} AS allowed` });
export const learningClaimAdmission = assertion<Admission>({ name: 'learningAdmission.claim', when: predicate, refusal: CLAIM_SELECTION_REFUSED });

/** A queued run rebuilding its input uses the same window and manual-origin rule as its claim. */
export async function learningRunAdmitted(db: RelationalStore, input: { project: string; session: string; run: string; now: number }): Promise<boolean> {
  return (await first(db, allowed.bind(input.project, input.session, input.run, input.now)))?.allowed === 1;
}
