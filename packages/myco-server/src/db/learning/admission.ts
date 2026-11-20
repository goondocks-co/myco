import { subjectCanRetry } from '../runs/interruptions.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import type { RelationalStore } from '../../core/adapters.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { assertion, first, read } from '../index.js';
import { CLAIM_SELECTION_REFUSED } from '../runs/claim-refusals.js';
import { learningEnabledSql } from '../settings/admission.js';
import { learningWindowSql } from '../runs/learning-policy.js';
import { manualCardRequestSql, MANUAL_LEARNING_SESSION } from './manual.js';

export const cardLearningEnabledSql = (): string => `(${learningEnabledSql()} OR ${manualCardRequestSql()})`;
export const cardLearningAdmittedSql = (now: string, readiness?: { automatic: string; manual: string }): string => `((${learningWindowSql(now)} AND ${learningEnabledSql()} AND ${subjectCanRetry('l.project_id', `'${CARD_TASK}'`, "'cards:'||l.session_id")}${readiness === undefined ? '' : ` AND ${readiness.automatic}`})
  OR (${manualCardRequestSql({ project: 'l.project_id', session: 'l.session_id' })}${readiness === undefined ? '' : ` AND ${readiness.manual}`}))`;

/** Only a named manual run may learn beyond the window; all manual runs bypass the automatic switch. */
const admitted = (slots: { project: string; session: string; run: string; now: string }) => `EXISTS(SELECT 1 FROM learning_sessions l
  WHERE l.project_id=${slots.project} AND l.session_id=${slots.session} AND (
    (${learningWindowSql(slots.now)} AND ((${learningEnabledSql()} AND ${subjectCanRetry('l.project_id', `'${EXTRACTION_TASK}'`, "'session:'||l.session_id")}) OR EXISTS(SELECT 1 FROM agent_runs r
      WHERE r.project_id=l.project_id AND r.id=${slots.run} AND r.task='${EXTRACTION_TASK}' AND r.origin='manual')))
    OR EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=l.project_id AND r.id=${slots.run} AND r.task='${EXTRACTION_TASK}' AND r.origin='manual'
      AND ${MANUAL_LEARNING_SESSION}=l.session_id)))`;
const predicate = admitted({ project: '?1', session: '?2', run: '?3', now: '?4' });
type Admission = [project: string, session: string, run: string, now: number];
const allowed = read<Admission, { allowed: number }>({ name: 'learningAdmission.run', sql: `SELECT ${predicate} AS allowed` });
export const learningClaimAdmission = assertion<Admission>({ name: 'learningAdmission.claim', when: `${predicate}
  AND EXISTS(SELECT 1 FROM learning_sessions WHERE project_id=?1 AND session_id=?2 AND pending_cards=0)`, refusal: CLAIM_SELECTION_REFUSED });
export const cardClaimAdmission = assertion<[project: string, session: string, now: number]>({ name: 'learningAdmission.cards',
  when: `EXISTS(SELECT 1 FROM learning_sessions l WHERE l.project_id=?1 AND l.session_id=?2 AND ${cardLearningAdmittedSql('?3')})`, refusal: CLAIM_SELECTION_REFUSED });

/** A queued run rebuilding its input uses the same window and manual-origin rule as its claim. */
export async function learningRunAdmitted(db: RelationalStore, input: { project: string; session: string; run: string; now: number }): Promise<boolean> {
  return (await first(db, allowed.bind(input.project, input.session, input.run, input.now)))?.allowed === 1;
}
