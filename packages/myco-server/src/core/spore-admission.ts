import { OPTIONAL_TEXT_BOUNDS, MAX_SPORE_ID_CHARS, MAX_SPORE_TAG_CHARS, MAX_FILE_PATH_CHARS, PROVENANCE_REF_MAX, COMMIT_REF_MIN_CHARS, COMMIT_REF_MAX_CHARS } from './spore-input-contract.js';
import { runRefusal } from './run-tool-contract.js';
import { withCurationWrite } from './spore-curation.js';
import { CURATION_TASK } from './task-catalogue.js';
import { memberWriteStore, MemberWriteRefused } from '../auth/member-write-store.js';
import { consolidateSpores, getSpore, insertSpore, repairImportedSporeSource, resolveSpore, SPORE_STATUSES, MAX_SPORE_CONTENT_BYTES, type ResolutionAction, type SporeProvenance, type SporeStatus, type SporeExpectation } from './spores.js';
import { mintSporeId, overSporeCap, planSporeConsolidation, planSporeResolution, SPORE_CAP_REASON, sporeTags, sporeExpectations } from './spore-writes.js';
import { dispatchedBeforeLedger, servedSessionStore, ServedSessionRefused, SESSION_NOT_SERVED } from './served-material.js';
import { extractionSourceSession } from '../read/prompts.js';
import { promptInSession } from '../read/turns.js';
import { projectHoldsSession, sessionHeldByMachine } from '../read/sessions.js';
import { EXTRACTION_TASK } from './task-catalogue.js';
import { AGENT_LINE_MAX_CHARS, AGENT_LINE_GUIDANCE } from './injection.js';
import { nearSpores } from './spore-near-matches.js';
import { USER_AGENT_ID } from '../constants.js';
import { importPolicy } from './import-policy.js';
import { ensureAgent } from './runs.js';
import type { RelationalStore, ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

export type SporePrincipal = { kind: 'member'; memberId: string; machineId: string } | { kind: 'grant'; grantId: string }
  | { kind: 'run'; runId: string; task: string | null; agentId: string; sessionId: string | null };
export interface SporeWriteContext { env: ServerEnv; projectId: string; principal: SporePrincipal; now: number; saveId?: string }
type SporeWriteInput = Record<string, unknown>;
type SporeWriteFailure = { ok: false; error: string; repairCall?: {tool:string;op:string;page?:number} };
const failure = (error: string, repairCall?: SporeWriteFailure['repairCall']): SporeWriteFailure => ({ ok: false, error, ...(repairCall === undefined ? {} : {repairCall}) });
const SESSION_NOT_FOUND = 'session_id not found';

const writerOf = (ctx: SporeWriteContext) => {
  const p = ctx.principal;
  return p.kind === 'member' ? { agentId: USER_AGENT_ID, author: p.memberId }
    : p.kind === 'grant' ? { agentId: p.grantId, author: p.grantId } : { agentId: p.agentId, author: p.runId };
};
async function sessionOf(ctx: SporeWriteContext, scope: ReadScope, input: SporeWriteInput): Promise<{ ok: true; sessionId: string | null } | SporeWriteFailure> {
  const named = typeof input.session_id === 'string' && input.session_id.length > 0 ? input.session_id : undefined;
  const p = ctx.principal;
  if (p.kind === 'grant') return named === undefined ? { ok: true, sessionId: null } : failure(SESSION_NOT_FOUND);
  if (p.kind === 'run') {
    if (named !== undefined && named !== p.sessionId) return failure(`session_id ${JSON.stringify(named)} is invalid for this run; ${p.sessionId === null ? 'no session id is valid: omit session_id' : 'valid session_id is '+JSON.stringify(p.sessionId)}`);
    return { ok: true, sessionId:p.sessionId !== null && await projectHoldsSession(ctx.env.db,scope,p.sessionId) ? p.sessionId : null };
  }
  if (named !== undefined && !await sessionHeldByMachine(ctx.env.db, scope, named, p.machineId)) return failure(SESSION_NOT_FOUND);
  return { ok: true, sessionId: named ?? null };
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/** The session citation of a new spore, admitted for its principal. */
async function sourceOf(input: SporeWriteInput, ctx: SporeWriteContext, scope: ReadScope): Promise<{ ok: true; sessionId: string | null; db: RelationalStore } | SporeWriteFailure> {
  const promptId = str(input.prompt_id);
  if (ctx.principal.kind === 'run' && ctx.principal.task === EXTRACTION_TASK) {
    if (!(await dispatchedBeforeLedger(ctx.env.db, scope, ctx.principal.runId)) || (promptId === undefined && str(input.session_id) !== undefined)) {
      const sessionId = str(input.session_id);
      if (sessionId === undefined) return failure('session_id is missing; extraction requires the supporting session served in material',{tool:'myco_run_learning',op:'material',page:1});
      const db = await servedSessionStore(ctx.env.db, scope, ctx.principal.runId, sessionId);
      if (db === null) return failure(`${SESSION_NOT_SERVED}; requested session_id ${JSON.stringify(sessionId)}`,{tool:'myco_run_learning',op:'material',page:1});
      return { ok: true, sessionId, db };
    }
    if (promptId === undefined) return failure('prompt_id is required for extraction spore writes');
    const sessionId = await extractionSourceSession(ctx.env.db, scope, promptId);
    if (sessionId === null) return failure('prompt_id not found');
    const named = str(input.session_id);
    if ((named !== undefined && named !== sessionId) || (ctx.principal.sessionId !== null && ctx.principal.sessionId !== sessionId)) return failure(SESSION_NOT_FOUND);
    return { ok: true, sessionId, db: ctx.env.db };
  }
  const session = await sessionOf(ctx, scope, input);
  if (!session.ok) return session;
  if (input.prompt_id !== undefined && (promptId === undefined || session.sessionId === null || !(await promptInSession(ctx.env.db, scope, session.sessionId, promptId)))) return failure('prompt_id not found');
  return { ...session, db: ctx.env.db };
}

const PROVENANCE_KINDS: ReadonlySet<string> = new Set(['pr', 'commit']);
/** The agent line a write carries, null where it carries none, or the one thing wrong with it. */
function agentLineOf(input: SporeWriteInput): { ok: true; agentLine: string | null } | SporeWriteFailure {
  const line = str(input.agent_line);
  if (line === undefined) return failure(`agent_line is missing; expected nonempty text within ${AGENT_LINE_MAX_CHARS} characters. ${AGENT_LINE_GUIDANCE}`);
  const oneLine = line.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0 || oneLine.length > AGENT_LINE_MAX_CHARS) return failure(`agent_line is ${oneLine.length} characters after whitespace normalization; the limit is ${AGENT_LINE_MAX_CHARS}. ${AGENT_LINE_GUIDANCE}`);
  return { ok: true, agentLine: oneLine };
}
const COMMIT_REF = new RegExp(`^[0-9a-f]{${COMMIT_REF_MIN_CHARS},${COMMIT_REF_MAX_CHARS}}$`);

/** One refusal for every malformed citation, so a caller learns the shape and nothing about the store. */
const PROVENANCE_REASON = 'provenance_kind and provenance_ref are given together: kind "pr" with an https URL, or kind "commit" with a sha';

/** What a write cites in place of a session, none, or the one thing wrong with the citation. */
function provenanceOf(input: SporeWriteInput): { ok: true; provenance: SporeProvenance | null } | SporeWriteFailure {
  const kind = str(input.provenance_kind);
  const ref = str(input.provenance_ref);
  if (input.provenance_kind === undefined && input.provenance_ref === undefined) return { ok: true, provenance: null };
  if (kind === undefined || ref === undefined || !PROVENANCE_KINDS.has(kind)) return failure(`${PROVENANCE_REASON}; kind is ${JSON.stringify(kind) ?? 'missing'}, ref is ${ref === undefined ? 'missing' : ref.length+' characters'}`);
  if (new TextEncoder().encode(ref).byteLength > PROVENANCE_REF_MAX) return failure(`provenance_ref is ${new TextEncoder().encode(ref).byteLength} UTF-8 bytes; the limit is ${PROVENANCE_REF_MAX}`);
  if (kind === 'commit' && !COMMIT_REF.test(ref)) return failure(`provenance_ref is ${ref.length} characters; commit requires ${COMMIT_REF_MIN_CHARS}–${COMMIT_REF_MAX_CHARS} hexadecimal characters`);
  if (kind === 'pr' && !ref.startsWith('https://')) return failure(`provenance_ref is ${ref.length}-character text without an https:// prefix; pr requires an https URL`);
  return { ok: true, provenance: { kind: kind as SporeProvenance['kind'], ref } };
}

async function resolve(
  ctx: SporeWriteContext, scope: ReadScope, sporeId: string, status: SporeStatus, action: ResolutionAction,
  newSporeId: string | null, reason: string | null, sessionId: string | null, provenance: SporeProvenance | null, expect: SporeExpectation, eventId?: string,
): Promise<true | 'duplicate' | SporeWriteFailure | (SporeWriteFailure & { status: string; revision: number; reason: string })> {
  const by = writerOf(ctx);
  const outcome = await resolveSpore(ctx.env.db, scope, status, {
    id: eventId ?? crypto.randomUUID(), agentId: by.agentId, author: by.author, sporeId, action, newSporeId, reason, sessionId, provenance, createdAt: ctx.now,
  }, ctx.now, expect, ctx.principal);
  if (typeof outcome === 'object') return { ...failure(outcome.error), status: outcome.status, revision: outcome.revision, reason: outcome.reason };
  if (outcome === false) return failure('spore_id not found');
  return outcome === 'duplicate' ? 'duplicate' : true;
}

function sporeMetadataError(input: SporeWriteInput): string | null {
  if (input.channel === 'import' && input.file_path != null && (typeof input.file_path !== 'string' || !input.file_path || input.file_path.length > MAX_FILE_PATH_CHARS)) return `file_path must be nonempty text of at most ${MAX_FILE_PATH_CHARS} characters`;
  for (const [field, max] of Object.entries(OPTIONAL_TEXT_BOUNDS)) {
    const value = input[field];
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length === 0 || value.length > max)) return `${field} is ${typeof value === 'string' ? value.length : 'not text'} characters; expected nonempty text of at most ${max} characters`;
  }
  if (input.tags !== undefined && input.tags !== null) {
    if (!Array.isArray(input.tags)) return `tags is ${typeof input.tags}; expected an array of strings`;
    const malformed = input.tags.findIndex(tag => typeof tag !== 'string');
    if (malformed !== -1) return `tags[${malformed}] is ${typeof input.tags[malformed]}; expected a string`;
    const chars = sporeTags(input.tags)?.length ?? 0;
    if (chars > MAX_SPORE_TAG_CHARS) return `serialized tags is ${chars} characters; the limit is ${MAX_SPORE_TAG_CHARS}`;
  }
  return null;
}

export async function writeSpore(input: SporeWriteInput, ctx: SporeWriteContext): Promise<unknown> {
  const apply = async (db: RelationalStore) => {
    const result = await admittedSporeWrite(input, {...ctx,env:{...ctx.env,db}});
    if (ctx.principal.kind === 'run' && result !== null && typeof result === 'object' && 'ok' in result && result.ok === false && 'error' in result) {
      const {repairCall, ...refused} = result as SporeWriteFailure;
      return {...refused, ...runRefusal({what:`myco_spores op ${String(input.op)}${typeof (input.id ?? input.old_spore_id) === 'string' ? ' for '+JSON.stringify(input.id ?? input.old_spore_id) : ''}`,actual:result.error === 'stale' && 'reason' in result ? String(result.reason) : String(result.error),
        next:repairCall ?? (result.error === 'stale' ? {tool:'myco_run',op:'report'} : {tool:'myco_spores',op:String(input.op)}),repair:'Correct the named input and retain the same sources. For a stale source, report with myco_run op report instead.'})};
    }
    return result;
  };
  return ctx.principal.kind === 'run' && ctx.principal.task === CURATION_TASK
    ? withCurationWrite(ctx.env.db,ctx.projectId,ctx.principal.runId,input,apply)
    : apply(ctx.env.db);
}

async function admittedSporeWrite(input: SporeWriteInput, ctx: SporeWriteContext): Promise<unknown> {
  const invalid = sporeMetadataError(input);
  if (invalid !== null) return failure(invalid);
  try { return await admitSporeWrite(input, ctx); }
  catch (error) {
    if (error instanceof Error && error.message.includes('[myco_curation_changed]')) return failure('assigned spores changed or the curation decision is closed',{tool:'myco_run',op:'report'});
    if (error instanceof MemberWriteRefused) return failure('import authority required');
    if (error instanceof ServedSessionRefused) return failure(SESSION_NOT_SERVED,{tool:'myco_run_learning',op:'material',page:1});
    throw error;
  }
}

async function admitSporeWrite(input: SporeWriteInput, ctx: SporeWriteContext): Promise<unknown> {
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const op = input.op;
  if (input.status !== undefined && !(SPORE_STATUSES as readonly unknown[]).includes(input.status)) return failure(`status is ${JSON.stringify(input.status)}; expected ${SPORE_STATUSES.join(', ')}`);
  if (input.channel === 'import') return importSporeWrite(input, ctx);
  if (ctx.principal.kind === 'grant' && ['supersede', 'obsolete', 'consolidate'].includes(String(op))) {
    const ids = op === 'supersede' || (op === 'consolidate' && input.new_spore_id !== undefined) ? [input.old_spore_id ?? input.id, input.new_spore_id] : op === 'obsolete' ? [input.id]
      : Array.isArray(input.source_spore_ids) ? input.source_spore_ids.map(value => typeof value === 'string' ? value : value?.id) : [];
    for (const id of ids) {
      const row = typeof id === 'string' ? await getSpore(db, scope, id) : null;
      if (row === null || row.author !== ctx.principal.grantId) return failure('spore_id not found');
    }
  }
  if (op === 'save') {
    const content = str(input.content);
    const type = str(input.type);
    if (content === undefined) return failure('content is required for op: save');
    if (type === undefined || type.length > MAX_SPORE_ID_CHARS) return failure(`type is ${type === undefined ? 'missing or not text' : type.length+' characters'}; expected nonempty text of at most ${MAX_SPORE_ID_CHARS} characters`);
    if (overSporeCap(content)) return failure(`${SPORE_CAP_REASON}; content is ${new TextEncoder().encode(String(input.content ?? input.consolidated_content ?? '')).length} UTF-8 bytes`);
    const by = writerOf(ctx);
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const lined = agentLineOf(input);
    if (!lined.ok) return lined;
    const session = await sourceOf(input, ctx, scope);
    if (!session.ok) return session;
    const spore = await insertSpore(session.db, scope, {
      id: ctx.saveId ?? mintSporeId(type), agentId: by.agentId, sessionId: session.sessionId, observationType: type,
      content, context: str(input.context) ?? null, filePath: null, tags: sporeTags(input.tags), contentHash: str(input.content_hash) ?? null, properties: str(input.properties) ?? null, importance: int(input.importance),
      author: by.author, provenance: cited.provenance, agentLine: lined.agentLine, createdAt: ctx.now,
    });
    if (spore === null) return ctx.saveId === undefined ? failure('Spore was not recorded') : { id: ctx.saveId, duplicate: true };
    return {
      id: spore.id, observation_type: spore.observationType, status: spore.status, created_at: spore.createdAt,
      ...(ctx.principal.kind === 'run' && ctx.principal.task === EXTRACTION_TASK ? { revision: spore.revision, near_matches: await nearSpores(ctx.env, scope, spore.id, lined.agentLine!) } : {}),
    };
  }

  const expectations = ['supersede', 'obsolete', 'consolidate'].includes(String(op))
    ? await sporeExpectations(db, scope, input.op === 'consolidate' && input.new_spore_id !== undefined ? { ...input, op: 'resolve' } : input, ctx.principal.kind === 'run' ? ctx.principal.runId : undefined)
    : { ok: true as const, expect: {} };
  if (!expectations.ok) return failure(expectations.reason);

  if (op === 'supersede' || (op === 'consolidate' && input.new_spore_id !== undefined)) {
    const planned = await planSporeResolution(db, scope, {
      action: op === 'supersede' ? 'supersede' : 'consolidate', sporeId: str(input.old_spore_id) ?? str(input.id), newSporeId: str(input.new_spore_id), reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const session = await sessionOf(ctx, scope, input);
    if (!session.ok) return session;
    const outcome = await resolve(ctx, scope, plan.sporeId, plan.status, plan.action, plan.newSporeId, plan.reason, session.sessionId, cited.provenance, expectations.expect, str(input.event_id));
    if (outcome !== true && outcome !== 'duplicate') return outcome;
    return { old_spore: plan.sporeId, new_spore: plan.newSporeId, status: plan.status, ...(outcome === 'duplicate' ? { duplicate: true } : {}) };
  }

  if (op === 'obsolete') {
    const planned = await planSporeResolution(db, scope, { action: 'obsolete', sporeId: str(input.id), reason: str(input.reason) });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const session = await sessionOf(ctx, scope, input);
    if (!session.ok) return session;
    const outcome = await resolve(ctx, scope, plan.sporeId, plan.status, 'obsolete', null, plan.reason, session.sessionId, cited.provenance, expectations.expect, str(input.event_id));
    if (outcome !== true && outcome !== 'duplicate') return outcome;
    return { spore: plan.sporeId, status: plan.status, ...(outcome === 'duplicate' ? { duplicate: true } : {}) };
  }

  if (op === 'consolidate') {
    const planned = await planSporeConsolidation(db, scope, {
      sources: 'sources' in expectations ? expectations.sources : [],
      content: str(input.consolidated_content),
      observationType: str(input.observation_type),
      reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const by = writerOf(ctx);
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const lined = agentLineOf(input);
    if (!lined.ok) return lined;
    const session = await sourceOf(input, ctx, scope);
    if (!session.ok) return session;
    const { wisdom, consolidated } = await consolidateSpores(session.db, scope, {
      id: mintSporeId(plan.observationType), agentId: by.agentId, sessionId: session.sessionId, observationType: plan.observationType,
      content: plan.content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null,
      author: by.author, provenance: cited.provenance, agentLine: lined.agentLine, createdAt: ctx.now,
    }, plan.sources, { agentId: by.agentId, author: by.author, reason: plan.reason, sessionId: session.sessionId, provenance: cited.provenance, createdAt: ctx.now }, ctx.now, ctx.principal);
    if (wisdom === null) return failure(ctx.principal.kind === 'grant' ? 'spore_id not found' : 'Consolidated spore was not recorded');
    return { new_spore_id: wisdom.id, sources_consolidated: consolidated, status: 'consolidated', created_at: wisdom.createdAt };
  }

  return failure('unknown spore operation');
}

/** Live members import their own history while the Deployment admits imports. */
async function importSporeWrite(input: SporeWriteInput, ctx: SporeWriteContext): Promise<unknown> {
  const p = ctx.principal;
  if (p.kind !== 'member' || !(await importPolicy(ctx.env.db)).enabled) return failure('import authority required');
  ctx = { ...ctx, env: { ...ctx.env, db: memberWriteStore(ctx.env.db, p.memberId, 'member') } };
  const scope = { projectId: ctx.projectId };
  const session = await sessionOf(ctx, scope, input);
  if (!session.ok) return session;
  const cited = provenanceOf(input);
  if (!cited.ok) return cited;
  const agentId = str(input.agent_id);
  if (agentId === undefined || agentId.length > MAX_SPORE_ID_CHARS) return failure('agentId is required for import');
  await ensureAgent(ctx.env.db, { id: agentId, name: agentId, provider: null, model: null, enabled: true }, ctx.now);
  const at = int(input.created_at) ?? ctx.now;
  if (input.op === 'save') {
    const id = str(input.id), content = str(input.content), type = str(input.type);
    if (id === undefined || content === undefined || type === undefined || overSporeCap(content)) return failure('import requires id, type and bounded content');
    if (input.status !== undefined && !(SPORE_STATUSES as readonly unknown[]).includes(input.status)) return failure('invalid spore status');
    const row = { id, agentId, sessionId: session.sessionId, observationType: type, content, author: p.memberId,
      channel: 'import' as const, provenance: cited.provenance, status: input.status as SporeStatus | undefined, createdAt: at, context: str(input.context) ?? null,
      filePath: str(input.file_path) ?? null, tags: typeof input.tags === 'string' ? input.tags : sporeTags(input.tags),
      contentHash: str(input.content_hash) ?? null, properties: str(input.properties) ?? null, importance: int(input.importance), agentLine: str(input.agent_line) ?? null };
    const saved = await insertSpore(ctx.env.db, scope, row);
    if (saved === null) {
      const source = await repairImportedSporeSource(ctx.env.db, scope, { id, agentId, content, sessionId: session.sessionId, author: p.memberId, createdAt: int(input.created_at) });
      if (await getSpore(ctx.env.db, scope, id) === null) return failure('Spore was not recorded');
      if (source === 'pending') return failure('the existing spore source could not be restored');
      return { id, duplicate: true, ...(source === 'kept' ? { sourceKept: true } : {}) };
    }
    return { id };
  }
  const action = input.op;
  if (action !== 'supersede' && action !== 'obsolete' && action !== 'consolidate') return failure('invalid resolution action');
  const id = str(input.id) ?? str(input.old_spore_id);
  const eventId = str(input.event_id);
  if (id === undefined || eventId === undefined) return failure('import resolution requires source and event id');
  const status = input.status;
  if (!(SPORE_STATUSES as readonly unknown[]).includes(status)) return failure('import resolution requires a known final status');
  const newSporeId = str(input.new_spore_id) ?? null;
  if (action === 'supersede' && newSporeId === null) return failure('supersede requires new_spore_id');
  const expect = await sporeExpectations(ctx.env.db, scope, { ...input, op: 'resolve' });
  if (!expect.ok) return failure(expect.reason);
  const outcome = await resolveSpore(ctx.env.db, scope, status as SporeStatus, { id: eventId, agentId, author: p.memberId, sporeId: id,
    action, newSporeId, reason: str(input.reason) ?? null, sessionId: session.sessionId, provenance: cited.provenance, channel: 'import', createdAt: at }, at, expect.expect);
  if (typeof outcome === 'object') return { ...failure(outcome.error), status: outcome.status, revision: outcome.revision, reason: outcome.reason };
  return { resolved: outcome !== false, ...(outcome === 'duplicate' ? { duplicate: true } : {}) };
}
