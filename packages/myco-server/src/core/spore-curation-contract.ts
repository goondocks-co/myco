import { OBSERVATION_TYPES } from '@goondocks/myco-shared/member-protocol';
import { CURATION_GUIDANCE_RULES } from './curation-guidance.js';
import { AGENT_LINE_MAX_CHARS } from './injection.js';

export const CURATION_CLUSTER_CAP = 12;
export const CURATION_REASON_CHARS = 2048;
export const CURATION_MATERIAL_BYTES = 32_000;
export const CURATION_BODY_CHARS = 1500;
export const CURATION_NEW_NOTES = 24;
export const CURATION_ANSWER_ATTEMPTS = 2;
export const CURATION_TYPES = OBSERVATION_TYPES;
export const CURATION_ANSWER_EXAMPLE = {
  op: 'answer',
  notes: [{ sources: ['decision-a'], observation_type: 'decision', agent_line: 'When delivery stalls, retain queued capture.', content: 'When delivery stalls, retain queued capture until the destination acknowledges it.' }],
  keep: ['gotcha-b'],
  retire: [],
  reason: 'One note needed a focused opening; the other already covers one situation.',
};
export const CURATION_ANSWER_BOUNDS = `Write 0–${CURATION_NEW_NOTES} notes. Each has 1–${CURATION_CLUSTER_CAP} distinct exact source ids, observation_type (${CURATION_TYPES.join('|')}), nonempty content of at most ${CURATION_BODY_CHARS} characters, and agent_line normalized to one nonempty line of at most ${AGENT_LINE_MAX_CHARS} characters. ${CURATION_GUIDANCE_RULES} Keep uses exact member ids. Retire entries have id, reason (1–${CURATION_REASON_CHARS} characters), and made_unnecessary_by (a kept member id or new:<zero-based note index>). Every assigned id occurs in exactly one disposition; a source may recur across new notes only for a split. reason is 1–${CURATION_REASON_CHARS} characters. Dates are derived by the server from sources; omit observed. Correct a refused answer once, at most ${CURATION_ANSWER_ATTEMPTS} submissions. Example: ${JSON.stringify(CURATION_ANSWER_EXAMPLE)}`;

export interface CurationNote {
  sources: string[];
  observation_type: string;
  agent_line: string;
  content: string;
}
export interface CurationAnswer {
  notes: CurationNote[];
  keep: string[];
  retire: { id: string; reason: string; made_unnecessary_by: string }[];
  reason: string;
}
