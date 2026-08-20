import { MAX_BLOB_BYTES } from '../constants.js';
import { utf8 } from '../hash.js';
import { AHEAD_OF_CLOCK, aheadOfClock, ID_GRAMMAR, MAX_ID_CHARS, MAX_PAYLOAD_BYTES, type Refused } from './envelope.js';
import { refusal, type Refusal } from '../telemetry.js';

/** Ceilings every bound of its type states; each is a real limit, never the language's. */
export const MAX_TIME_MS = 4_102_444_800_000;
export const MAX_DURATION_MS = 2_592_000_000;
export const MAX_TOKEN_COUNT = 100_000_000;
export const MAX_TRANSCRIPT_BYTES = 1_099_511_627_776;
export const MAX_ARRAY_ITEMS = 1_000;

/** A blob key: the lowercase hex SHA-256 of the bytes. */
export const BLOB_KEY_GRAMMAR = /^[0-9a-f]{64}$/;
/** A transcript id: the deterministic `tx_` + 32 hex form derived from (machine, path, inode), or a member-minted id in the envelope's one lowercase id grammar — composed here from that grammar itself, so the two can never drift into case-forked ids. */
export const TRANSCRIPT_ID_GRAMMAR = new RegExp(`^(tx_[0-9a-f]{32}|${ID_GRAMMAR.source.slice(1, -1)})$`);

export type Bound =
  | { type: 'id' }
  | { type: 'transcriptId' }
  | { type: 'sessionId' }
  | { type: 'blobKey' }
  | { type: 'string'; max: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'int'; min: number; max: number }
  /** A caller-supplied instant that decides a merge order. Bounded by the same rule the envelope applies to `createdAt`: no further ahead of the server clock than the skew bound, so one bad clock cannot pin a projected column forever. */
  | { type: 'time' }
  | { type: 'bool' }
  | { type: 'stringArray'; maxItems: number; maxItem: number }
  | { type: 'json'; maxBytes: number };

/** What an id-bounded field names: the row the event itself keys, a prompt row it points at, or a grouping every member mints for itself. Every id field declares one, so a field naming a prompt cannot enter the catalogue unmarked. */
export type IdRole = 'key' | 'prompt' | 'group';

export interface FieldSpec {
  bound: Bound;
  required?: boolean;
  /** The typed column this field lands in, when it does; every column-mapped field carries a bound by construction. */
  column?: string;
  /** What the id names; every id-bounded field declares it and no other field carries one. */
  role?: IdRole;
  /** The row this field names, when it names one; a reference is admitted only when the referenced row is absent or owned by the writing machine. Derived from the role, never set apart from it. */
  references?: 'prompt';
}

export interface KindSpec {
  name: string;
  fields: Readonly<Record<string, FieldSpec>>;
  /** A pair of fields of which exactly one must be present (inline text or its spilled blob key). */
  exactlyOne?: readonly [string, string];
  /** A pair of fields of which at most one may be present. */
  atMostOne?: readonly [string, string];
  /** The projection target, or 'raw' when the kind is stored in the log only. */
  projection: 'raw' | 'sessions' | 'prompt_batches' | 'tool_calls' | 'responses' | 'plans' | 'attachments' | 'transcript_segments';
}

/** A member-minted id under a declared role. A `prompt` role carries the reference marker the shared admission and the shared reads derive from: a named prompt must be absent or owned by the writing machine. */
const id = (role: IdRole, column?: string, required = false): FieldSpec =>
  ({ bound: { type: 'id' }, required, column, role, ...(role === 'prompt' ? { references: 'prompt' as const } : {}) });
const promptRef = (column?: string, required = false): FieldSpec => id('prompt', column, required);
const str = (max: number, column?: string, required = false): FieldSpec => ({ bound: { type: 'string', max }, required, column });
const int = (max: number, column?: string, required = false, min = 0): FieldSpec => ({ bound: { type: 'int', min, max }, required, column });
const blob = (column: string, required = false): FieldSpec => ({ bound: { type: 'blobKey' }, required, column });
/** A caller-supplied instant that participates in a merge ordering; `orderingTime` refuses to read a field bounded any other way. */
const time = (column: string): FieldSpec => ({ bound: { type: 'time' }, column });
/** An open JSON value bounded by the encoded length of its serialization; the payload cap is the same ceiling stated per field. */
const json = (column?: string): FieldSpec => ({ bound: { type: 'json', maxBytes: MAX_PAYLOAD_BYTES }, column });

export const PROMPT_ORIGINS = ['user', 'system', 'agent_dispatch', 'hook_injected', 'unknown'] as const;
export const PLAN_STATUSES = ['active', 'in_progress', 'completed', 'abandoned'] as const;

const toolCallFields: Record<string, FieldSpec> = {
  toolCallId: id('key', 'tool_call_id', true),
  promptId: promptRef('prompt_id'),
  toolName: str(64, 'tool_name', true),
  input: json('input'),
  blob: blob('input_blob_key'),
  output: str(4096, 'output_preview'),
  outputBlob: blob('output_blob_key'),
  durationMs: int(MAX_DURATION_MS, 'duration_ms'),
  filesAffected: { bound: { type: 'stringArray', maxItems: 100, maxItem: 1024 }, column: 'files_affected' },
  success: { bound: { type: 'bool' }, required: true, column: 'success' },
  mycoTool: str(64, 'myco_tool'),
  mycoOp: str(64, 'myco_op'),
  canopyInjectionTokens: int(MAX_TOKEN_COUNT, 'canopy_injection_tokens'),
};

/** The closed kind catalogue: payload schema, bounds, and projection target per kind. */
export const KINDS: readonly KindSpec[] = [
  {
    name: 'session.start',
    fields: {
      agent: str(64, 'agent', true),
      branch: str(256, 'branch'),
      startedAt: time('started_at'),
      originPath: str(1024, 'origin_path'),
      parentSessionId: { bound: { type: 'sessionId' }, column: 'parent_session_id' },
      parentReason: str(64, 'parent_reason'),
    },
    projection: 'sessions',
  },
  { name: 'session.end', fields: { endedAt: time('ended_at') }, projection: 'sessions' },
  {
    name: 'prompt',
    fields: {
      promptId: promptRef('prompt_id', true),
      text: str(262_144, 'text'),
      blob: blob('blob_key'),
      origin: { bound: { type: 'enum', values: PROMPT_ORIGINS }, required: true, column: 'origin' },
      promptKind: str(64, 'prompt_kind'),
      parentPromptId: promptRef('parent_prompt_id'),
      threadId: id('group', 'thread_id'),
      threadLabel: str(256, 'thread_label'),
    },
    exactlyOne: ['text', 'blob'],
    projection: 'prompt_batches',
  },
  { name: 'tool.use', fields: toolCallFields, exactlyOne: ['input', 'blob'], atMostOne: ['output', 'outputBlob'], projection: 'tool_calls' },
  {
    name: 'tool.failure',
    fields: { ...toolCallFields, errorMessage: str(4096, 'error_message', true) },
    exactlyOne: ['input', 'blob'],
    atMostOne: ['output', 'outputBlob'],
    projection: 'tool_calls',
  },
  {
    name: 'response',
    fields: { responseId: id('key', 'response_id', true), promptId: promptRef('prompt_id'), text: str(262_144, 'text'), blob: blob('blob_key') },
    exactlyOne: ['text', 'blob'],
    projection: 'responses',
  },
  {
    name: 'plan',
    fields: {
      planKey: id('key', 'plan_key', true),
      title: str(256, 'title'),
      content: str(262_144, 'content'),
      blob: blob('blob_key'),
      status: { bound: { type: 'enum', values: PLAN_STATUSES }, column: 'status' },
      originPath: str(1024, 'origin_path'),
      tags: { bound: { type: 'stringArray', maxItems: 32, maxItem: 64 } },
    },
    exactlyOne: ['content', 'blob'],
    projection: 'plans',
  },
  {
    name: 'attachment',
    fields: {
      attachmentId: id('key', 'attachment_id', true),
      promptId: promptRef('prompt_id'),
      blob: blob('blob_key', true),
      description: str(4096, 'description'),
      originPath: str(1024, 'origin_path'),
    },
    projection: 'attachments',
  },
  {
    name: 'transcript.segment',
    fields: {
      transcriptId: { bound: { type: 'transcriptId' }, required: true, column: 'transcript_id' },
      baseOffset: int(MAX_TRANSCRIPT_BYTES, 'base_offset', true),
      length: int(MAX_BLOB_BYTES, 'length', true, 1),
      blob: blob('blob_key', true),
      originPath: str(1024, 'origin_path'),
      agent: str(64, 'agent'),
    },
    projection: 'transcript_segments',
  },
  { name: 'compaction.pre', fields: { trigger: str(64), summary: str(262_144), blob: blob('blob_key') }, atMostOne: ['summary', 'blob'], projection: 'raw' },
  { name: 'compaction.post', fields: { trigger: str(64), summary: str(262_144), blob: blob('blob_key') }, atMostOne: ['summary', 'blob'], projection: 'raw' },
  { name: 'subagent.start', fields: { subagentId: id('key', undefined, true), agentType: str(64), parentPromptId: promptRef() }, projection: 'raw' },
  { name: 'subagent.stop', fields: { subagentId: id('key', undefined, true), agentType: str(64), parentPromptId: promptRef() }, projection: 'raw' },
  { name: 'stop.failure', fields: { message: str(4096), data: json() }, projection: 'raw' },
  { name: 'task.completed', fields: { message: str(4096), data: json() }, projection: 'raw' },
  { name: 'notification', fields: { message: str(4096, undefined, true), level: str(64), data: json() }, projection: 'raw' },
  { name: 'error', fields: { message: str(4096, undefined, true), level: str(64), data: json() }, projection: 'raw' },
];

const BY_NAME = new Map(KINDS.map((k) => [k.name, k]));

/** The blob-key fields of a kind; every one must reference a blob present in the project. */
export function blobFields(spec: KindSpec): string[] {
  return Object.entries(spec.fields).filter(([, f]) => f.bound.type === 'blobKey').map(([field]) => field);
}

/** The fields of a kind that name a prompt row, taken from the field's own reference marker. */
export function promptReferenceFields(spec: KindSpec): string[] {
  return Object.entries(spec.fields).filter(([, f]) => f.references === 'prompt').map(([field]) => field);
}

/** Every id-bounded field of a kind with the role it declares. */
export function idFields(spec: KindSpec): [string, IdRole | undefined][] {
  return Object.entries(spec.fields).filter(([, f]) => f.bound.type === 'id').map(([field, f]) => [field, f.role]);
}

/** The typed columns a prompt reference lands in; a field mapped to one of them without the marker is unbound. */
export const PROMPT_REFERENCE_COLUMNS = ['prompt_id', 'parent_prompt_id'] as const;

/** The payload fields of a kind whose values decide a merge ordering; every one carries the `time` bound. */
export function orderingFields(spec: KindSpec): string[] {
  return Object.entries(spec.fields).filter(([, f]) => f.bound.type === 'time').map(([field]) => field);
}

export function kindSpec(name: string): KindSpec | null {
  return BY_NAME.get(name) ?? null;
}

export type Payload = Record<string, unknown>;
export type PayloadResult = { ok: true; value: Payload } | Refused;
const refused = (reason: string, classifier?: Refusal['classifier']): Refused => ({ ok: false, ...refusal(reason, classifier) });

/** Statically total over the bound union: a bound shape the switch below does not classify fails to compile. */
const unclassified = (bound: never): never => { throw new Error(`unclassified bound ${JSON.stringify(bound)}`); };

/** The refusal a value earns under a bound, or null when it satisfies it; each grammar and clock refusal is made with its classifier. */
function boundViolation(field: string, value: unknown, bound: Bound, now: number): Refusal | null {
  switch (bound.type) {
    case 'id':
      return typeof value === 'string' && ID_GRAMMAR.test(value) ? null : refusal(`${field} must match the id grammar`, 'id_grammar');
    case 'transcriptId':
      return typeof value === 'string' && TRANSCRIPT_ID_GRAMMAR.test(value) ? null : refusal(`${field} must match the transcript id grammar`, 'id_grammar');
    case 'sessionId':
      return typeof value === 'string' && value !== '' && value.length <= MAX_ID_CHARS ? null : refusal(`${field} must be a non-empty string of at most ${MAX_ID_CHARS} characters`);
    case 'blobKey':
      return typeof value === 'string' && BLOB_KEY_GRAMMAR.test(value) ? null : refusal(`${field} must be a lowercase hex sha256`);
    case 'string':
      return typeof value === 'string' && value.length <= bound.max ? null : refusal(`${field} must be a string of at most ${bound.max} characters`);
    case 'enum':
      return typeof value === 'string' && bound.values.includes(value) ? null : refusal(`${field} must be one of ${bound.values.join(', ')}`);
    case 'int': {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= bound.min && value <= bound.max) return null;
      return refusal(bound.min === 0
        ? `${field} must be a non-negative integer of at most ${bound.max}`
        : `${field} must be an integer between ${bound.min} and ${bound.max}`);
    }
    case 'time': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refusal(`${field} must be a non-negative integer`);
      return aheadOfClock(value, now) ? refusal(AHEAD_OF_CLOCK(field), 'clock_skew') : null;
    }
    case 'bool':
      return typeof value === 'boolean' ? null : refusal(`${field} must be a boolean`);
    case 'stringArray':
      return Array.isArray(value) && value.length <= bound.maxItems && value.every((v) => typeof v === 'string' && v.length <= bound.maxItem)
        ? null
        : refusal(`${field} must be an array of at most ${bound.maxItems} strings of at most ${bound.maxItem} characters`);
    case 'json':
      return utf8(JSON.stringify(value)).byteLength <= bound.maxBytes ? null : refusal(`${field} must serialize to at most ${bound.maxBytes} bytes`);
  }
  return unclassified(bound);
}

/** Validates a kind's payload against its schema: closed field set, required fields, exactly-one and at-most-one pairs, and every bound. `now` is the server clock the time bounds are read against. */
export function parsePayload(spec: KindSpec, payload: unknown, now: number): PayloadResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return refused('payload must be an object');
  const raw = payload as Payload;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(spec.fields, key)) return refused(`unknown field payload.${key}`, 'unknown_field');
  }
  for (const [field, f] of Object.entries(spec.fields)) {
    const value = raw[field];
    if (value === undefined) {
      if (f.required) return refused(`${field} is required`);
      continue;
    }
    const violation = boundViolation(field, value, f.bound, now);
    if (violation !== null) return { ok: false, ...violation };
  }
  if (spec.exactlyOne) {
    const [a, b] = spec.exactlyOne;
    if ((raw[a] === undefined) === (raw[b] === undefined)) return refused(`exactly one of ${a} or ${b} is required`);
  }
  if (spec.atMostOne) {
    const [a, b] = spec.atMostOne;
    if (raw[a] !== undefined && raw[b] !== undefined) return refused(`at most one of ${a} or ${b} is allowed`);
  }
  return { ok: true, value: raw };
}
