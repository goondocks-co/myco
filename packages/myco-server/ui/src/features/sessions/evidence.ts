import type { SessionEvidence } from './wire';
import { count } from './words';

/** A visible count is an observation; absent coverage is stated explicitly. */
export function countEvidence(answer: Pick<SessionEvidence, 'visibility' | 'counts'>, kind: 'toolCalls' | 'failedTools' | 'mycoCalls', singular: string, plural?: string): string {
  return answer.counts[kind] == null || answer.visibility[kind] === 'not_visible' ? `${singular}: not visible` : count(answer.counts[kind], singular, plural);
}

export function fileEditWords(edits: SessionEvidence['fileEdits'] | null | undefined): string {
  if (edits == null) return 'Files edited: not visible';
  return edits.state === 'count' ? count(edits.count, 'file edited', 'files edited')
    : edits.state === 'unknown' && edits.observed > 0 ? `At least ${count(edits.observed, 'file edited', 'files edited')}` : 'Files edited: not visible';
}
