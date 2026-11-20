import { z } from 'zod';

export const TranscriptEvidenceSchema = z.object({
  toolCalls: z.enum(['recorded', 'not_visible']),
  failedTools: z.enum(['recorded', 'not_visible']),
  mycoCalls: z.enum(['recorded', 'not_visible']),
  filesEdited: z.enum(['observed', 'not_visible']),
  commits: z.literal('member_report_required'),
});
export type TranscriptEvidence = z.infer<typeof TranscriptEvidenceSchema>;

export const CompletedToolSchema = z.object({
  match: z.record(z.string(), z.string()),
  key: z.string(),
  turnAt: z.string().optional(),
  name: z.string().optional(),
  nameAt: z.string().optional(),
  serverAt: z.string().optional(),
  inputAt: z.string().optional(),
  inputFields: z.record(z.string(), z.string()).optional(),
  outputAt: z.string(),
  exitCodeAt: z.string().optional(),
  statusAt: z.string().optional(),
  failedStatus: z.string().optional(),
});
export type CompletedTool = z.infer<typeof CompletedToolSchema>;

export const UNSEEN_TRANSCRIPT_EVIDENCE: TranscriptEvidence = {
  toolCalls: 'not_visible', failedTools: 'not_visible', mycoCalls: 'not_visible', filesEdited: 'not_visible', commits: 'member_report_required',
};
