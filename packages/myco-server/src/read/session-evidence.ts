import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import type { TranscriptEvidence } from '@goondocks/myco-shared/transcript-evidence';
import type { documentCounters } from './document-catalog.js';

const UNSEEN_TRANSCRIPT_EVIDENCE: TranscriptEvidence = {
  toolCalls: 'not_visible', failedTools: 'not_visible', mycoCalls: 'not_visible', filesEdited: 'not_visible', commits: 'member_report_required',
};

/** Transcript facts have declared coverage; file paths are observations and never a complete count of shell edits. */
export function sessionEvidence(agent: string | null, counts: Awaited<ReturnType<typeof documentCounters>>) {
  const visibility = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)?.transcriptEvidence ?? UNSEEN_TRANSCRIPT_EVIDENCE;
  const visible = (kind: 'toolCalls' | 'failedTools' | 'mycoCalls') => visibility[kind] === 'not_visible' ? 0 : counts?.[kind] ?? 0;
  const observedFilesEdited = counts?.filesEdited ?? 0;
  const fileEdits = visibility.filesEdited === 'recorded' ? { state: 'count' as const, count: observedFilesEdited }
    : visibility.filesEdited === 'observed' ? { state: 'unknown' as const, observed: observedFilesEdited } : { state: 'not_visible' as const };
  return { visibility: { ...visibility, commits: 'not_visible' as const }, toolCalls: visible('toolCalls'), failedTools: visible('failedTools'), mycoCalls: visible('mycoCalls'),
    fileEdits, filesEdited: observedFilesEdited, observedFilesEdited,
    turns: counts?.turns ?? 0, personTurns: counts?.userTurns ?? 0, promptEntries: counts?.prompts ?? 0,
    nestedToolCalls: counts?.nestedToolCalls ?? 0, reportedErrors: counts?.reportedErrors ?? 0,
    counts: { userPrompts: counts?.userPrompts ?? 0, mycoCalls: visible('mycoCalls'), prompts: counts?.prompts ?? 0,
      promptEntries: counts?.prompts ?? 0, toolCalls: visible('toolCalls'), failedTools: visible('failedTools'),
      responses: counts?.replies ?? 0, plans: counts?.plans ?? 0, attachments: counts?.attachments ?? 0 } };
}
