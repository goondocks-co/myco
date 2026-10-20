import { getAtPath, parseDotPath } from './dot-path.js';
import type { PromptIdHasher, PromptIdRequest } from './prompt-identity.js';

export const RECORD_ID_SCHEMES = {
  'legacy-session-v1': { generation: 1 },
  'source-record-v1': { generation: 1 },
} as const;
export type RecordIdScheme = keyof typeof RECORD_ID_SCHEMES;
export const LEGACY_RECORD_ID_SCHEME: RecordIdScheme = 'legacy-session-v1';
export const isRecordIdScheme = (value: unknown): value is RecordIdScheme =>
  typeof value === 'string' && Object.hasOwn(RECORD_ID_SCHEMES, value);
export const RECORD_KINDS = ['response', 'tool-call', 'plan'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface RecordField {
  from: 'record' | 'call' | 'result';
  path: string | readonly string[];
}
export interface RecordSourceDeclaration {
  key?: RecordField;
  resultKey?: RecordField;
  thread?: RecordField & { absent?: string };
  position?: true;
  absentKey?: 'position';
  withinRecord?: 'content-block' | 'record-text' | 'content-block-envelope' | 'record-text-envelope';
  evidence: string;
}
export interface RecordIdentityDeclaration {
  scheme: RecordIdScheme;
  schemes: Partial<Record<RecordIdScheme, Partial<Record<RecordKind, RecordSourceDeclaration>>>>;
}
export type ReplySource = { key: string; thread?: string; block: number } | { position: true; block: number };

export class RecordKindUndeclared extends Error {
  readonly code = 'record_kind_undeclared';
  constructor() { super('Record kind is not declared'); this.name = 'RecordKindUndeclared'; }
}
export class RecordSourceInvalid extends Error {
  readonly code = 'record_source_invalid';
  constructor() { super('Record source is invalid'); this.name = 'RecordSourceInvalid'; }
}
export class RecordSourceAbsent extends RecordSourceInvalid {
  constructor() { super(); this.name = 'RecordSourceAbsent'; }
}
export class RecordIdentityDeclarationInvalid extends Error {
  readonly code = 'record_identity_scheme_unsupported';
  constructor() { super('Record identity declaration is unsupported'); this.name = 'RecordIdentityDeclarationInvalid'; }
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const keyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** The exact source anchor carried by a held reply part. */
export function isReplySource(value: unknown): value is ReplySource {
  if (!object(value) || !index(value.block)) return false;
  if (value.position === true) return Object.keys(value).every((key) => key === 'position' || key === 'block');
  return keyString(value.key) && (value.thread === undefined || keyString(value.thread))
    && Object.keys(value).every((key) => ['key', 'thread', 'block'].includes(key));
}
const fieldValid = (value: unknown, thread = false): boolean => {
  if (!object(value) || !['record', 'call', 'result'].includes(String(value.from))) return false;
  if (Object.keys(value).some((key) => !['from', 'path', ...(thread ? ['absent'] : [])].includes(key))) return false;
  const paths = typeof value.path === 'string' ? [value.path] : value.path;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every(keyString)) return false;
  try { if (paths.some((path) => parseDotPath(path).length === 0)) return false; } catch { return false; }
  return value.absent === undefined || (thread && keyString(value.absent));
};

/** Validates the retained definitions and their common emitted-kind set. */
export function assertRecordIdentityDeclaration(_agent: string, declaration: unknown): asserts declaration is RecordIdentityDeclaration {
  const refuse = (): never => { throw new RecordIdentityDeclarationInvalid(); };
  if (!object(declaration) || !isRecordIdScheme(declaration.scheme) || !object(declaration.schemes)) refuse();
  const d = declaration as unknown as RecordIdentityDeclaration;
  if (Object.keys(declaration as object).some((key) => key !== 'scheme' && key !== 'schemes')) refuse();
  if (!d.schemes[d.scheme] || !d.schemes[LEGACY_RECORD_ID_SCHEME]) refuse();
  const kinds = Object.keys(d.schemes[d.scheme]!).sort().join(',');
  for (const [scheme, rules] of Object.entries(d.schemes)) {
    if (!isRecordIdScheme(scheme) || !object(rules) || !rules.response || Object.keys(rules).sort().join(',') !== kinds) refuse();
    for (const [kind, raw] of Object.entries(rules)) {
      if (!(RECORD_KINDS as readonly string[]).includes(kind) || !object(raw)) refuse();
      const r = raw as unknown as RecordSourceDeclaration;
      if (Object.keys(raw as object).some((key) => !['key', 'resultKey', 'thread', 'position', 'absentKey', 'withinRecord', 'evidence'].includes(key))) refuse();
      if (!keyString(r.evidence) || (r.key === undefined) === (r.position === undefined)) refuse();
      if (r.key !== undefined && !fieldValid(r.key)) refuse();
      if (r.position !== undefined && r.position !== true) refuse();
      if (r.resultKey !== undefined && (kind !== 'tool-call' || !fieldValid(r.resultKey))) refuse();
      if (r.thread !== undefined && (r.key === undefined || !fieldValid(r.thread, true))) refuse();
      if (r.absentKey !== undefined && (r.key === undefined || r.absentKey !== 'position')) refuse();
      if (kind === 'response' && !['content-block', 'record-text'].includes(r.withinRecord ?? '')) refuse();
      if (kind === 'plan' && !['content-block-envelope', 'record-text-envelope'].includes(r.withinRecord ?? '')) refuse();
      if (kind === 'tool-call' && r.withinRecord !== undefined) refuse();
    }
  }
}

/** Checks pinned-kind admission before selecting the source field declaration. */
export function recordSourceDeclaration(request: {
  declaration: RecordIdentityDeclaration | undefined; scheme: RecordIdScheme; kind: RecordKind;
}): RecordSourceDeclaration {
  const { declaration, scheme, kind } = request;
  if (declaration?.schemes[scheme]?.[kind] === undefined) throw new RecordKindUndeclared();
  const sourceScheme = scheme === LEGACY_RECORD_ID_SCHEME ? declaration.scheme : scheme;
  const rule = declaration.schemes[sourceScheme]?.[kind];
  if (rule === undefined) throw new RecordKindUndeclared();
  return rule;
}
export interface RecordSourceRequest {
  declaration: RecordIdentityDeclaration | undefined;
  scheme: RecordIdScheme;
  kind: RecordKind;
  record?: unknown;
  call?: unknown;
  result?: unknown;
  role?: 'call' | 'result';
  block?: number;
}
const readField = (field: RecordField, request: RecordSourceRequest): unknown => {
  const paths = typeof field.path === 'string' ? [field.path] : field.path;
  for (const path of paths) {
    const value = getAtPath(request[field.from], path);
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
};

/** Extracts declared source facts independently of the pinned derivation. */
export function extractRecordSource(request: RecordSourceRequest): ReplySource {
  const rule = recordSourceDeclaration(request);
  const block = request.block ?? (rule.withinRecord?.startsWith('content-block') ? undefined : 0);
  if (!index(block) || (rule.withinRecord?.startsWith('record-text') && block !== 0)) throw new RecordSourceInvalid();
  const keyField = request.role === 'result' ? rule.resultKey ?? rule.key : rule.key;
  if (keyField === undefined) return { position: true, block };
  const key = readField(keyField, request);
  if (key === undefined || key === null || key === '') {
    if (rule.absentKey === 'position') return { position: true, block };
    throw new RecordSourceAbsent();
  }
  if (typeof key !== 'string' || key.length === 0) throw new RecordSourceInvalid();
  const thread = rule.thread === undefined ? undefined : readField(rule.thread, request) ?? rule.thread.absent;
  if (rule.thread !== undefined && (typeof thread !== 'string' || thread.length === 0)) throw new RecordSourceInvalid();
  return { key, ...(thread === undefined ? {} : { thread: thread as string }), block };
}

/** Selects the manifest's original within-record plan coordinates. */
export function recordPlanCoordinate(request: {
  declaration: RecordIdentityDeclaration | undefined; scheme: RecordIdScheme; source: ReplySource; matchIndex: number;
}): readonly (string | number)[] {
  const rule = recordSourceDeclaration({ ...request, kind: 'plan' });
  if (!index(request.source.block) || !index(request.matchIndex)) throw new RecordSourceInvalid();
  if (rule.withinRecord === 'content-block-envelope') return [request.source.block, request.matchIndex];
  if (rule.withinRecord === 'record-text-envelope' && request.source.block === 0) return ['record-text', request.matchIndex];
  throw new RecordSourceInvalid();
}

export type LegacyRecordIdRequest =
  | { kind: 'response'; sessionId: string; offset: number }
  | { kind: 'tool-call'; sessionId: string; offset: number; source?: ReplySource }
  | { kind: 'plan'; sessionId: string; tag: string; legacyPosition: number }
  | { kind: 'plan'; sessionId: string; tag: string; legacyPromptId: string };

/** The compatibility derivation for parser rows and member plan tags. */
export function deriveLegacyRecordId<R>(hash: PromptIdHasher<R>, request: LegacyRecordIdRequest): R {
  switch (request.kind) {
    case 'response': return hash('response', request.sessionId, String(request.offset));
    case 'tool-call': return hash('tool-call', request.sessionId,
      request.source !== undefined && 'key' in request.source ? request.source.key : String(request.offset));
    case 'plan': return 'legacyPromptId' in request
      ? hash('plan-tag', request.sessionId, request.tag, 'prompt', request.legacyPromptId)
      : hash('plan-tag', request.sessionId, request.tag, String(request.legacyPosition));
  }
}
/** Frozen response identities from imported legacy vault history. */
export function legacyImportedResponseId<R>(hash: PromptIdHasher<R>, request: {
  projectId: string; legacyId: string; identity: 'row' | 'event';
}): R {
  return hash('legacy', request.projectId, request.identity === 'row' ? 'response-id' : 'response', request.legacyId);
}

interface RecordRequestBase {
  scheme: RecordIdScheme;
  sessionId: string;
  transcriptId: string;
  agent: string;
  source: ReplySource;
  offset: number;
}
export type RecordIdRequest = RecordRequestBase & (
  | { kind: 'response' | 'tool-call' }
  | { kind: 'plan'; tag: string; coordinate: readonly (string | number)[]; legacyPosition?: number }
);

/** Mints one logical record id from declared source facts. */
export function canonicalRecordId<R>(hash: PromptIdHasher<R>, request: RecordIdRequest): R {
  const { source } = request;
  if (!isRecordIdScheme(request.scheme)) throw new RecordSourceInvalid();
  if (request.scheme === LEGACY_RECORD_ID_SCHEME) {
    if (request.kind === 'plan') {
      if (!index(request.legacyPosition)) throw new RecordSourceInvalid();
      return deriveLegacyRecordId(hash, { kind: request.kind, sessionId: request.sessionId, tag: request.tag, legacyPosition: request.legacyPosition });
    }
    return deriveLegacyRecordId(hash, { kind: request.kind, sessionId: request.sessionId, offset: request.offset, source });
  }
  if (!index(request.offset) || !isReplySource(source)
    || !keyString(request.sessionId) || !keyString(request.transcriptId) || !keyString(request.agent)) throw new RecordSourceInvalid();
  if (request.kind === 'plan' && (!keyString(request.tag) || request.coordinate.length === 0
    || request.coordinate.some((part) => typeof part === 'number' ? !index(part) : !keyString(part)))) throw new RecordSourceInvalid();
  if (request.kind === 'tool-call' && 'key' in source) return hash('tool-call', request.sessionId, source.key);
  if ('position' in source) return hash('source-position-v1', request.transcriptId, request.kind, String(request.offset),
    ...(request.kind === 'response' ? [String(source.block)] : request.kind === 'plan' ? [request.tag, ...request.coordinate.map(String)] : []));
  if (request.kind === 'response') return hash('source-response-v1', request.sessionId, request.agent, source.thread ?? '', source.key, String(source.block));
  if (request.kind === 'plan') return hash('source-plan-v1', request.sessionId, request.agent, source.thread ?? '', source.key, request.tag, ...request.coordinate.map(String));
  throw new RecordSourceInvalid();
}
/** Statically total over the derived schemes: a scheme the switch does not derive fails to compile. */
const underived = (request: never): never => { throw new Error(`no derivation for ${JSON.stringify(request)}`); };

/**
 * The canonical id of one prompt under its scheme. The only prompt-id derivation: a `uuidv5`/`deriveId` of a prompt
 * anywhere else fails `tests/meta/prompt-identity-sources.test.ts`. A stamped id is the hook's own and is taken as it is.
 */
export function canonicalPromptId<R>(hash: PromptIdHasher<R>, request: PromptIdRequest): R | string {
  switch (request.scheme) {
    case 'claude-v1':
      return hash('queued-prompt', request.sessionId, `${request.shape}|${request.key}`);
    case 'claude-v2':
      return hash('queued-prompt', request.sessionId, 'owner' in request.record ? `user_prompt|${request.record.owner}`
        : 'queued' in request.record ? `queued_command|${request.record.queued}` : `record|${request.record.thread}|${request.record.uuid}`);
    case 'offset-v1':
      return hash(request.namespace, request.sessionId, String(request.offset));
    case 'stamp-or-offset-v1':
      return request.stamp ?? hash('prompt', request.sessionId, String(request.offset));
    case 'codex-turn-v1':
      return hash('codex-turn', request.sessionId, request.turnId, 'opener' in request.submission ? 'opener'
        : 'order' in request.submission ? `order|${request.submission.order}` : `offset|${request.submission.offset}`);
    case 'member-transcript-v1':
      return request.dedupeKey === undefined
        ? hash('transcript-prompt', request.sessionId, String(request.position))
        : hash('queued-prompt', request.sessionId, request.dedupeKey);
    case 'legacy-v1':
      return hash('legacy', request.projectId, 'prompt', request.legacyId);
    default:
      return underived(request);
  }
}
