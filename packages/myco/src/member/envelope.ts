/**
 * The member envelope: normalized hook input → one phase-1 capture event per
 * kind in the server's closed catalogue. Every builder returns the complete
 * envelope the wire accepts (`{eventId, sessionId, kind, createdAt, channel,
 * producer, payload}`) and, when a field travels as a blob, the source the
 * spool re-reads at drain time. Text over the inline ceiling is staged
 * through the injected `stage` function and referenced by its SHA-256.
 *
 * Ids: minted ids are UUIDv7 (`Bun.randomUUIDv7`); derived ids are UUIDv5
 * over `MEMBER_ID_NAMESPACE` so a lost session-state or a second machine
 * derives the same id from the same facts.
 */
import crypto from 'node:crypto';
import { resolveHomeDir } from '../paths/home.js';
import { getPluginVersion } from '../version.js';
import { TOOL_OUTPUT_PREVIEW_CHARS } from '../constants.js';
import type { NormalizedHookInput } from '../hooks/normalize.js';
import type { PromptOrigin } from '../hooks/capture-rules.js';
import { MEMBER_ID_NAMESPACE, MEMBER_INLINE_TEXT_MAX_BYTES } from './constants.js';

export type MemberKind =
  | 'session.start' | 'session.end' | 'prompt' | 'tool.use' | 'tool.failure' | 'response' | 'plan' | 'attachment'
  | 'transcript.segment' | 'compaction.pre' | 'compaction.post' | 'subagent.start' | 'subagent.stop'
  | 'stop.failure' | 'task.completed' | 'notification' | 'error';

export interface MemberEnvelope {
  eventId: string;
  sessionId: string;
  kind: MemberKind;
  createdAt: number;
  channel: 'cli';
  producer: { adapter: string; version: string };
  payload: Record<string, unknown>;
}

/** Where the bytes of a blob-referenced field live until the drain uploads them. */
export interface BlobSource {
  path: string;
  sha256: string;
  mediaType: string;
  size: number;
}

/** One event ready for the spool: the wire envelope plus its blob source, when the payload references one. */
export interface OutboundEvent {
  envelope: MemberEnvelope;
  blobSource?: BlobSource;
}

/** Writes bytes somewhere the drain can read them back and returns the reference; the member spool supplies this. */
export type BlobStager = (bytes: Uint8Array, mediaType: string) => BlobSource;

export interface EnvelopeContext {
  /** The manifest name of the symbiont driving the hook (`producer.adapter`). */
  agent: string;
  sessionId: string;
  stage: BlobStager;
  now?: () => number;
  version?: string;
}

export const TEXT_MEDIA_TYPE = 'text/plain; charset=utf-8';
export const JSON_MEDIA_TYPE = 'application/json';

/** Server-side string bounds the builders truncate to (pinned against the worker catalogue by `tests/member/protocol-pins.test.ts`). */
export const BOUNDS = {
  agent: 64, branch: 256, originPath: 1024, parentReason: 64, toolName: 64, output: 4096, errorMessage: 4096,
  mycoTool: 64, mycoOp: 64, agentType: 64, trigger: 64, message: 4096, level: 64, threadLabel: 256, title: 256,
  description: 4096, fileItem: 1024, tagItem: 64,
} as const;
const MAX_FILES_AFFECTED = 100;
const MAX_PLAN_TAGS = 32;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** A fresh time-ordered id. */
export function mintId(): string {
  return Bun.randomUUIDv7();
}

const NAMESPACE_BYTES = Buffer.from(MEMBER_ID_NAMESPACE.replace(/-/g, ''), 'hex');

/** UUIDv5 over the member namespace of the NUL-joined parts. */
export function deriveId(...parts: string[]): string {
  const hash = crypto.createHash('sha1');
  hash.update(NAMESPACE_BYTES);
  hash.update(parts.join('\0'));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const subagentIdFor = (sessionId: string, agentId: string): string => deriveId('subagent', sessionId, agentId);
export const planKeyForPath = (projectId: string, planPath: string): string => deriveId('plan', projectId, planPath);
export const planKeyForTag = (sessionId: string, tag: string, position: number): string => deriveId('plan-tag', sessionId, tag, String(position));
export const queuedPromptIdFor = (sessionId: string, attachmentUuid: string): string => deriveId('queued-prompt', sessionId, attachmentUuid);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An absolute path with the user's home prefix replaced by `~`. */
export function homeRelativePath(p: string): string {
  const home = resolveHomeDir();
  if (p === home) return '~';
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
}

const trunc = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;

const sha256Hex = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

/** True when the value's JSON serialization — the size the server measures — fits under the inline ceiling. */
export function fitsInline(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf-8') <= MEMBER_INLINE_TEXT_MAX_BYTES;
}

/** The inline field, or the blob reference when the text's serialized size exceeds the inline ceiling. */
function inlineOrBlob(ctx: EnvelopeContext, field: string, text: string): { fields: Record<string, unknown>; blobSource?: BlobSource } {
  if (fitsInline(text)) return { fields: { [field]: text } };
  const source = ctx.stage(Buffer.from(text, 'utf-8'), TEXT_MEDIA_TYPE);
  return { fields: { blob: source.sha256 }, blobSource: source };
}

/** The inline JSON field, or the blob reference when its serialization exceeds the inline ceiling. */
function inlineJsonOrBlob(ctx: EnvelopeContext, field: string, value: unknown): { fields: Record<string, unknown>; blobSource?: BlobSource } {
  if (fitsInline(value)) return { fields: { [field]: value ?? null } };
  const source = ctx.stage(Buffer.from(JSON.stringify(value ?? null), 'utf-8'), JSON_MEDIA_TYPE);
  return { fields: { blob: source.sha256 }, blobSource: source };
}

/** An open JSON value bounded by its serialized size; over the ceiling it is replaced by a size marker. */
function boundedJson(value: unknown): unknown {
  return fitsInline(value) ? value : { truncated: true, bytes: Buffer.byteLength(JSON.stringify(value ?? null), 'utf-8') };
}

function compact(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (v !== undefined) out[k] = v;
  return out;
}

function envelope(ctx: EnvelopeContext, kind: MemberKind, payload: Record<string, unknown>, blobSource?: BlobSource): OutboundEvent {
  const env: MemberEnvelope = {
    eventId: mintId(),
    sessionId: ctx.sessionId,
    kind,
    createdAt: (ctx.now ?? Date.now)(),
    channel: 'cli',
    producer: { adapter: ctx.agent, version: ctx.version ?? getPluginVersion() },
    payload: compact(payload),
  };
  return blobSource ? { envelope: env, blobSource } : { envelope: env };
}

/** Hook-rule origins map onto the wire's: `human` is the wire's `user`; the others keep their name. */
export function wireOrigin(origin: PromptOrigin | undefined): 'user' | 'system' | 'agent_dispatch' | 'hook_injected' {
  return origin === undefined || origin === 'human' ? 'user' : origin;
}

const MYCO_TOOL_PATTERN = /^myco_[a-z_]+$/;

/** `mycoTool`/`mycoOp` for a `myco_*` tool call (bare or MCP-prefixed `mcp__<server>__myco_*`), from the tool name and its `op` argument. */
function mycoToolFields(toolName: string, toolInput: unknown): { mycoTool?: string; mycoOp?: string } {
  const leaf = toolName.split('__').pop() ?? toolName;
  if (!MYCO_TOOL_PATTERN.test(leaf)) return {};
  const op = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>).op : undefined;
  return { mycoTool: trunc(leaf, BOUNDS.mycoTool), mycoOp: trunc(op, BOUNDS.mycoOp) };
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** File paths named by a tool input's conventional path keys. */
function filesAffected(toolInput: unknown): string[] | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const record = toolInput as Record<string, unknown>;
  const files: string[] = [];
  for (const key of FILE_KEYS) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= BOUNDS.fileItem) files.push(v);
  }
  return files.length > 0 ? files.slice(0, MAX_FILES_AFFECTED) : undefined;
}

function toolCallPayload(ctx: EnvelopeContext, input: NormalizedHookInput, opts: { promptId?: string; toolCallId?: string; success: boolean }) {
  const toolName = trunc(input.toolName, BOUNDS.toolName) ?? 'unknown';
  const spilled = inlineJsonOrBlob(ctx, 'input', input.toolInput);
  const output = typeof input.toolOutput === 'string' ? input.toolOutput.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) : undefined;
  return {
    payload: {
      toolCallId: opts.toolCallId ?? mintId(),
      promptId: opts.promptId,
      toolName,
      ...spilled.fields,
      output,
      success: opts.success,
      ...mycoToolFields(toolName, input.toolInput),
      filesAffected: filesAffected(input.toolInput),
    },
    blobSource: spilled.blobSource,
  };
}

// ---------------------------------------------------------------------------
// Builders — one per kind
// ---------------------------------------------------------------------------

export function sessionStartEvent(ctx: EnvelopeContext, facts: {
  branch?: string; startedAt?: number; originPath?: string; parentSessionId?: string; parentReason?: string;
}): OutboundEvent {
  return envelope(ctx, 'session.start', {
    agent: trunc(ctx.agent, BOUNDS.agent),
    branch: trunc(facts.branch, BOUNDS.branch),
    startedAt: facts.startedAt,
    originPath: facts.originPath === undefined ? undefined : trunc(homeRelativePath(facts.originPath), BOUNDS.originPath),
    parentSessionId: facts.parentSessionId,
    parentReason: trunc(facts.parentReason, BOUNDS.parentReason),
  });
}

export function sessionEndEvent(ctx: EnvelopeContext, facts: { endedAt?: number } = {}): OutboundEvent {
  return envelope(ctx, 'session.end', { endedAt: facts.endedAt ?? (ctx.now ?? Date.now)() });
}

export function promptEvent(ctx: EnvelopeContext, facts: {
  promptId: string; text: string; origin?: PromptOrigin; parentPromptId?: string; threadId?: string; threadLabel?: string;
}): OutboundEvent {
  const spilled = inlineOrBlob(ctx, 'text', facts.text);
  return envelope(ctx, 'prompt', {
    promptId: facts.promptId,
    ...spilled.fields,
    origin: wireOrigin(facts.origin),
    parentPromptId: facts.parentPromptId,
    threadId: facts.threadId,
    threadLabel: trunc(facts.threadLabel, BOUNDS.threadLabel),
  }, spilled.blobSource);
}

export function toolUseEvent(ctx: EnvelopeContext, input: NormalizedHookInput, opts: { promptId?: string; toolCallId?: string } = {}): OutboundEvent {
  const { payload, blobSource } = toolCallPayload(ctx, input, { ...opts, success: true });
  return envelope(ctx, 'tool.use', payload, blobSource);
}

export function toolFailureEvent(ctx: EnvelopeContext, input: NormalizedHookInput, opts: { promptId?: string; toolCallId?: string } = {}): OutboundEvent {
  const { payload, blobSource } = toolCallPayload(ctx, input, { ...opts, success: false });
  const error = input.raw.error;
  const errorMessage = typeof error === 'string' ? error : error === undefined ? 'tool failed' : JSON.stringify(error);
  return envelope(ctx, 'tool.failure', { ...payload, errorMessage: errorMessage.slice(0, BOUNDS.errorMessage) || 'tool failed' }, blobSource);
}

export function responseEvent(ctx: EnvelopeContext, facts: { text: string; promptId?: string; responseId?: string }): OutboundEvent {
  const spilled = inlineOrBlob(ctx, 'text', facts.text);
  return envelope(ctx, 'response', {
    responseId: facts.responseId ?? mintId(),
    promptId: facts.promptId,
    ...spilled.fields,
  }, spilled.blobSource);
}

function subagentPayload(ctx: EnvelopeContext, input: NormalizedHookInput, parentPromptId: string | undefined): Record<string, unknown> {
  const agentId = typeof input.raw.agent_id === 'string' && input.raw.agent_id.length > 0 ? input.raw.agent_id : mintId();
  return {
    subagentId: subagentIdFor(ctx.sessionId, agentId),
    agentType: trunc(input.raw.agent_type, BOUNDS.agentType),
    parentPromptId,
  };
}

export function subagentStartEvent(ctx: EnvelopeContext, input: NormalizedHookInput, opts: { parentPromptId?: string } = {}): OutboundEvent {
  return envelope(ctx, 'subagent.start', subagentPayload(ctx, input, opts.parentPromptId));
}

export function subagentStopEvent(ctx: EnvelopeContext, input: NormalizedHookInput, opts: { parentPromptId?: string } = {}): OutboundEvent {
  return envelope(ctx, 'subagent.stop', subagentPayload(ctx, input, opts.parentPromptId));
}

export function compactionEvent(ctx: EnvelopeContext, phase: 'pre' | 'post', input: NormalizedHookInput): OutboundEvent {
  const summary = typeof input.raw.compact_summary === 'string' && input.raw.compact_summary.length > 0 ? input.raw.compact_summary : undefined;
  const spilled = summary === undefined ? { fields: {} } : inlineOrBlob(ctx, 'summary', summary);
  return envelope(ctx, phase === 'pre' ? 'compaction.pre' : 'compaction.post', {
    trigger: trunc(input.raw.trigger, BOUNDS.trigger),
    ...spilled.fields,
  }, spilled.blobSource);
}

/** The first non-empty string among the named keys. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

export function stopFailureEvent(ctx: EnvelopeContext, input: NormalizedHookInput): OutboundEvent {
  return envelope(ctx, 'stop.failure', {
    message: trunc(firstString(input.raw, ['error', 'message']), BOUNDS.message),
    data: boundedJson({ error: input.raw.error, error_details: input.raw.error_details }),
  });
}

export function taskCompletedEvent(ctx: EnvelopeContext, input: NormalizedHookInput): OutboundEvent {
  return envelope(ctx, 'task.completed', {
    message: trunc(firstString(input.raw, ['task_subject', 'message']), BOUNDS.message),
    data: boundedJson({ task_id: input.raw.task_id, task_subject: input.raw.task_subject, task_description: input.raw.task_description }),
  });
}

/** The raw hook payload without the identity fields every hook carries. */
function dataOf(input: NormalizedHookInput): Record<string, unknown> {
  const { session_id, transcript_path, cwd, hook_event_name, ...rest } = input.raw;
  void session_id; void transcript_path; void cwd; void hook_event_name;
  return rest;
}

export function notificationEvent(ctx: EnvelopeContext, input: NormalizedHookInput): OutboundEvent {
  const message = firstString(input.raw, ['message', 'notification', 'title', 'text']) ?? JSON.stringify(dataOf(input));
  return envelope(ctx, 'notification', {
    message: message.slice(0, BOUNDS.message),
    level: trunc(firstString(input.raw, ['level', 'severity', 'notification_type']), BOUNDS.level),
    data: boundedJson(dataOf(input)),
  });
}

export function errorEvent(ctx: EnvelopeContext, input: NormalizedHookInput): OutboundEvent {
  const message = firstString(input.raw, ['message', 'error', 'title']) ?? JSON.stringify(dataOf(input));
  return envelope(ctx, 'error', {
    message: message.slice(0, BOUNDS.message),
    level: trunc(firstString(input.raw, ['level', 'severity', 'code']), BOUNDS.level),
    data: boundedJson(dataOf(input)),
  });
}

export function planEvent(ctx: EnvelopeContext, facts: {
  planKey: string; content: string; title?: string; status?: 'active' | 'in_progress' | 'completed' | 'abandoned'; originPath?: string; tags?: string[];
}): OutboundEvent {
  const spilled = inlineOrBlob(ctx, 'content', facts.content);
  return envelope(ctx, 'plan', {
    planKey: facts.planKey,
    title: trunc(facts.title, BOUNDS.title),
    ...spilled.fields,
    status: facts.status,
    originPath: facts.originPath === undefined ? undefined : trunc(homeRelativePath(facts.originPath), BOUNDS.originPath),
    tags: facts.tags?.slice(0, MAX_PLAN_TAGS).map((t) => t.slice(0, BOUNDS.tagItem)),
  }, spilled.blobSource);
}

/** An attachment whose bytes are already staged (an image decoded from a transcript, a file on disk). */
export function attachmentEvent(ctx: EnvelopeContext, facts: {
  blobSource: BlobSource; attachmentId?: string; promptId?: string; description?: string; originPath?: string;
}): OutboundEvent {
  return envelope(ctx, 'attachment', {
    attachmentId: facts.attachmentId ?? mintId(),
    promptId: facts.promptId,
    blob: facts.blobSource.sha256,
    description: trunc(facts.description, BOUNDS.description),
    originPath: facts.originPath === undefined ? undefined : trunc(homeRelativePath(facts.originPath), BOUNDS.originPath),
  }, facts.blobSource);
}

/** One slice of a transcript: the bytes are read from the transcript file itself at drain time. */
export function transcriptSegmentEvent(ctx: EnvelopeContext, facts: {
  transcriptId: string; baseOffset: number; blobSource: BlobSource; originPath?: string;
}): OutboundEvent {
  if (facts.blobSource.size < 1) throw new Error('transcriptSegmentEvent: a segment carries at least one byte');
  return envelope(ctx, 'transcript.segment', {
    transcriptId: facts.transcriptId,
    baseOffset: facts.baseOffset,
    length: facts.blobSource.size,
    blob: facts.blobSource.sha256,
    originPath: facts.originPath === undefined ? undefined : trunc(homeRelativePath(facts.originPath), BOUNDS.originPath),
    agent: trunc(ctx.agent, BOUNDS.agent),
  }, facts.blobSource);
}

/** A blob source for bytes the caller already holds, staged through the context. */
export function stageBytes(ctx: EnvelopeContext, bytes: Uint8Array, mediaType: string): BlobSource {
  return ctx.stage(bytes, mediaType);
}

/** The SHA-256 the blob route keys on. */
export { sha256Hex as blobKeyOf };
