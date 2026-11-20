import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { UNSEEN_TRANSCRIPT_EVIDENCE } from '@goondocks/myco-shared/transcript-evidence';
import type { documentCounters } from './document-catalog.js';

/** Transcript facts have declared coverage; file paths are observations and never a complete count of shell edits. */
export function sessionEvidence(agent: string | null, counts: Awaited<ReturnType<typeof documentCounters>>) {
  const visibility = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)?.transcriptEvidence ?? UNSEEN_TRANSCRIPT_EVIDENCE;
  const visible = (kind: 'toolCalls' | 'failedTools' | 'mycoCalls') => visibility[kind] === 'not_visible' ? null : counts?.[kind] ?? 0;
  return { visibility, toolCalls: visible('toolCalls'), failedTools: visible('failedTools'), mycoCalls: visible('mycoCalls'),
    filesEdited: null, observedFilesEdited: counts?.filesEdited ?? 0,
    counts: { userPrompts: counts?.userTurns ?? 0, mycoCalls: visible('mycoCalls'), prompts: counts?.turns ?? 0,
      promptEntries: counts?.prompts ?? 0, toolCalls: visible('toolCalls'), failedTools: visible('failedTools'),
      responses: counts?.replies ?? 0, plans: counts?.plans ?? 0, attachments: counts?.attachments ?? 0 } };
}
