/**
 * Document records from the closed kind catalogue. A parsed transcript event and a member's hook event carry the same
 * payload for a kind, so one mapping serves both; `at` names where the record came from.
 *
 * A tool record keeps its name, its input, a one-line summary of that input, its outcome, an error excerpt, the files
 * it affected and a bounded preview of its output. The complete output is not kept.
 *
 * A plan record is one appearance of a plan: its id is the member event that carried it, or the transcript record
 * the parser minted, and `plan_key` names the canonical plan.
 */
import { filesNamedByToolInput } from '@goondocks/myco-shared/member-protocol';
import { utf8Preview } from '../hash.js';
import { assembleToolOutcome, type OutcomeSource, type ToolAssembly } from '../ingest/tool-outcome.js';
import { DOCUMENT_PREVIEW_BYTES, type DocRecord, type RecordKind } from './document.js';

/** Characters a tool's one-line input summary keeps. */
export const TOOL_SUMMARY_CHARS = 200;

export interface RecordOrigin {
  src?: readonly [string, number, number];
  ev?: string;
  received_at: number;
  /** Source order of a parsed tool call and its outcome, for merging later outcomes. */
  call?: OutcomeSource | null;
  outcome?: OutcomeSource;
}

const RECORD_KINDS: Readonly<Record<string, RecordKind>> = {
  prompt: 'prompt', response: 'reply', 'tool.use': 'tool', 'tool.failure': 'tool', plan: 'plan',
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const text = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? {}));
const preview = (value: unknown): string | null => (typeof value === 'string' ? utf8Preview(value, DOCUMENT_PREVIEW_BYTES).preview : null);

/** One line naming what a tool call acted on: its command, path, pattern or URL, else its input's first line. */
export function toolSummary(input: unknown): string {
  const held = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null;
  const named = held === null ? null
    : ['command', 'cmd', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description']
      .map((key) => held[key]).find((value) => typeof value === 'string' || Array.isArray(value));
  const line = (named === undefined || named === null ? text(input) : Array.isArray(named) ? named.join(' ') : String(named))
    .replace(/\s+/g, ' ').trim();
  return line.length <= TOOL_SUMMARY_CHARS ? line : `${line.slice(0, TOOL_SUMMARY_CHARS - 1)}…`;
}

/** The record an event of a document kind becomes, or null for any other kind. */
export function documentRecord(kind: string, payload: Record<string, unknown>, createdAt: number, at: RecordOrigin): DocRecord | null {
  const k = RECORD_KINDS[kind];
  if (k === undefined) return null;
  const origin = { created_at: createdAt, received_at: at.received_at, ...(at.src ? { src: at.src } : {}), ...(at.ev ? { ev: at.ev } : {}) };
  const p = payload;
  if (k === 'prompt') {
    const parent = str(p.parentPromptId);
    return {
      k, id: String(p.promptId), prompt_id: parent, ...origin, parent_prompt_id: parent, thread_id: str(p.threadId),
      thread_label: str(p.threadLabel), origin: str(p.origin) ?? 'user', prompt_kind: str(p.promptKind), text: str(p.text),
      claim: str(p.claim), source_key: str(p.sourceKey), source_thread: str(p.sourceThread), source_record: str(p.sourceRecord),
      prompt_key_hash: str(p.promptKeyHash),
    };
  }
  if (k === 'reply') return { k, id: String(p.responseId), prompt_id: str(p.promptId), ...origin, text: str(p.text) };
  if (k === 'plan') {
    return {
      k, id: at.ev ?? String(p.planKey), plan_key: String(p.planKey), prompt_id: str(p.promptId), ...origin, title: str(p.title), content: str(p.content),
      status: str(p.status) ?? 'active', origin_path: str(p.originPath), source: str(p.source) ?? 'tag',
      tags: Array.isArray(p.tags) ? p.tags : [],
    };
  }
  const input = text(p.input);
  const failed = p.success === false || kind === 'tool.failure';
  return {
    k, id: String(p.toolCallId), prompt_id: str(p.promptId), ...origin,
    tool_name: str(p.toolName) ?? 'unknown', myco_tool: str(p.mycoTool), myco_op: str(p.mycoOp),
    summary: toolSummary(p.input), input, input_bytes: new TextEncoder().encode(input).length,
    files_affected: Array.isArray(p.filesAffected) ? p.filesAffected : filesNamedByToolInput(p.input),
    success: failed ? 0 : 1, output_preview: preview(p.output), error_message: preview(p.errorMessage),
    result_reason: str(p.resultReason), duration_ms: typeof p.durationMs === 'number' ? p.durationMs : null,
    call_source: at.call === undefined ? (str(p.toolName) && p.toolName !== 'unknown' ? { ordinal: 0, offset: 0, origin: 'reported' } : null) : at.call,
    outcome_source: at.outcome ?? { ordinal: 0, offset: 0, origin: 'reported' },
  };
}

/**
 * A record arriving under an id the document already holds. A tool call merges its call and outcome by source order;
 * any other record keeps the version first published.
 */
export function mergeRecord(held: DocRecord, incoming: DocRecord): DocRecord {
  if (held.k !== 'tool' || incoming.k !== 'tool') return held;
  const assembly = (record: DocRecord): ToolAssembly => ({
    values: record, call: (record.call_source ?? null) as OutcomeSource | null, outcome: record.outcome_source as OutcomeSource,
  });
  const merged = assembleToolOutcome(assembly(held), assembly(incoming));
  const record: DocRecord = { ...(merged.values as DocRecord), call_source: merged.call, outcome_source: merged.outcome };
  if (held.call_source == null && incoming.call_source != null) {
    record.summary = incoming.summary;
    const { input: _replaced, ...bodies } = held.bodies ?? {};
    record.bodies = Object.keys(bodies).length === 0 ? undefined : bodies;
  }
  return record;
}
