import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { UNSEEN_TRANSCRIPT_EVIDENCE } from '@goondocks/myco-shared/transcript-evidence';

/** Transcript facts have declared coverage; file paths are observations and never a complete count of shell edits. */
export function sessionEvidence(agent: string | null, counts: { toolCalls: number; failedTools: number; mycoCalls: number; filesEdited: number } | null) {
  const visibility = CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)?.transcriptEvidence ?? UNSEEN_TRANSCRIPT_EVIDENCE;
  const visible = (kind: 'toolCalls' | 'failedTools' | 'mycoCalls') => visibility[kind] === 'not_visible' ? null : counts?.[kind] ?? 0;
  return { visibility, toolCalls: visible('toolCalls'), failedTools: visible('failedTools'), mycoCalls: visible('mycoCalls'),
    filesEdited: null, observedFilesEdited: counts?.filesEdited ?? 0 };
}
