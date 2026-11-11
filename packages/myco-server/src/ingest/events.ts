import { DOCUMENT_EVENT_KINDS } from '../db/document-tables.js';

import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { emit, refusal, StorageContractError, TokenRevokedError, type Classifier, type Refusal } from '../telemetry.js';
import { parseEnvelope, type CaptureEnvelope, type Refused } from './envelope.js';
import { blobFields, kindSpec, parsePayload, promptReferenceFields, type KindSpec, type Payload } from './kinds.js';
import { searchBlobsDue } from '../db/search/blob-index.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';
import { RecordSchemeError } from './record-scheme.js';
import { checkRefusal, planKind, type KindPlan, type ReadRows, type WriteContext } from './projections.js';
import { DOCUMENT_TEXT_FIELDS, documentText } from './document-text.js';

import {
  CONTEXT_DELIVERED_KIND,
  isDeliveredSessionRecord,
  isPromptIdScheme,
  type PromptScopeReason,
} from '@goondocks/myco-shared/prompt-identity';
import { endsTurn, turnStartFrom } from './turns.js';
import { endTurn, startTurnFromEvent } from '../db/sessions/turns.js';
import { commit, first, type Bound } from '../db/index.js';
import { captureChecks, eventAdmitted, rawEventInsert, type CaptureFacts } from '../db/capture/admission.js';
import { deliverAnswer, deliverInjection, deliverSessionRecord, type Delivered } from '../db/capture/deliveries.js';
import { chargeStoredBytes, credentialStillLive, liveReceipt, sessionReceipt, storedEvent } from '../db/capture/event-write.js';

import { EVENT_INLINE_PAYLOAD_BYTES, retainedEventPayload } from './event-payload.js';
import { prepareEventBody, settleUnstoredEventBody } from '../core/event-body.js';
import { eventBodyHeldRead, eventBodyStatements, type EventBody } from '../db/events/body.js';

/** The held size and segment count of a transcript, answered on every outcome of a `transcript.segment`. */
interface TranscriptExtra {
  transcript?: { size: number; segmentCount: number };
}

/** Stored (projected, or a duplicate), stored but not projected (a conflict with its stable `code`), or refused with its stable `code`: a refusal or a conflict without a `code` cannot be built. */
export type IngestResult =
  | ({ persisted: true; duplicate?: boolean; projected?: true } & TranscriptExtra)
  | ({ persisted: true; projected: false; code: Classifier; reason: string } & TranscriptExtra)
  | ({ persisted: false; code: Classifier; reason: string } & TranscriptExtra);

/**
 * Who is writing.
 *
 * `member` is a credentialed caller: the write is admitted only while its
 * credential is live, and its bytes are counted on that credential for
 * reporting. `server` is the Deployment writing from bytes it has already
 * accepted and already counted — a transcript it parsed — so it is counted
 * nothing and its admission does not consult a
 * credential's liveness. A member's credential rotates; the events derived from
 * the bytes that credential shipped must not stop landing when it does.
 */
type WriteOrigin = 'member' | 'server';

export type IngestContext = Pick<
  RouteContext,
  'projectId' | 'machineId' | 'tokenId' | 'bodyBytes' | 'now' | 'turnEnd'
> & {
  writeOrigin?: WriteOrigin;
  /** The member acting through a server-origin write, where a projection records who acted; absent for a member's own capture and for derived events. */ actor?: string;
};

/** A terminal refusal of the caller's own request: 200 `{persisted:false, code, reason}` plus one `ingest_refused` event carrying the refusal's classifier only. */
export function refused(
  ctx: Pick<IngestContext, 'projectId' | 'tokenId'>,
  { reason, classifier }: Refusal,
): IngestResult {
  emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  return { persisted: false, code: classifier, reason };
}

/** Digest of the whole envelope: session, kind, caller time, channel, producer, and the serialized payload. */
async function envelopeHash(e: CaptureEnvelope): Promise<string> {
  const header = utf8(
    `${JSON.stringify([e.sessionId, e.kind, e.createdAt, e.channel, e.producer.adapter, e.producer.version])}\n`,
  );
  const bytes = new Uint8Array(header.byteLength + e.payloadBytes.byteLength);
  bytes.set(header, 0);
  bytes.set(e.payloadBytes, header.byteLength);
  return sha256HexOf(bytes);
}

/** The content hash a text-bearing kind records: sha256 of the inline text, or the blob key when spilled. */
async function contentHashOf(spec: KindSpec, p: Payload): Promise<string | null> {
  const inline = spec.exactlyOne?.[0];
  if (inline === undefined) return null;
  if (typeof p[inline] === 'string') return sha256Hex(p[inline] as string);
  return typeof p.blob === 'string' ? (p.blob as string) : null;
}

/** The blob key holding a kind's spilled text field, when the text travelled as a blob. */
function spilledKey(spec: KindSpec, p: Payload): string | null {
  const pair = spec.exactlyOne ?? spec.atMostOne;
  return pair && pair[1] === 'blob' && typeof p.blob === 'string' ? (p.blob as string) : null;
}

/**
 * A delivery's effect on the rows it names, through the modules that own them: each is marked delivered at the event's
 * own instant, in its own session, once, and only when this request stored the event.
 */
function deliveryStatements(ctx: WriteContext, e: CaptureEnvelope, p: Payload): Bound[] {
  if (e.kind !== CONTEXT_DELIVERED_KIND) return [];
  const delivered: Delivered = {
    projectId: ctx.projectId,
    sessionId: e.sessionId,
    at: e.createdAt,
    promptId: typeof p.renderedIn === 'string' ? p.renderedIn : null,
    scopeReason: typeof p.renderedScopeReason === 'string' ? (p.renderedScopeReason as PromptScopeReason) : null,
    scheme: isPromptIdScheme(p.renderedScheme) ? p.renderedScheme : null,
    eventId: e.eventId,
    nonce: ctx.nonce,
  };
  // The session record by its own key; from a member that names only the answer, through the answer while it is held.
  const record = isDeliveredSessionRecord(p.sessionRecord)
    ? [deliverSessionRecord(delivered, p.sessionRecord)]
    : typeof p.answerId === 'string'
      ? [deliverSessionRecord(delivered, 'plan-nudge', p.answerId)]
      : [];
  return [
    ...(typeof p.receiptId === 'string' ? [deliverInjection(delivered, p.receiptId)] : []),
    ...(typeof p.answerId === 'string' ? [deliverAnswer(delivered, p.answerId)] : []),
    ...record,
  ];
}

/** Stores one event in a single transaction. The raw insert carries every admission precondition — the credential still live (`credentialLive`; never a volume: capture is not refused for the bytes a credential has stored), the shared checks derived from the catalogue and the kind's declared identities (session identity, the continued rows the kind names, referenced blobs present, referenced prompts owned by this machine — in that order) and the kind's own — so a refused event leaves no row and no count; the byte count, the session receipt, and the kind's projections apply only to the raw row this request wrote, named by a per-request nonce; same-batch reads decide the response. A stored event is read through its session's machine, so a duplicate or a conflict is answered only to the machine that wrote it and another machine's event id is refused like any other unstored one. */
export async function ingestEvent(
  db: RelationalStore,
  ctx: IngestContext,
  body: unknown,
  env?: Pick<ServerEnv, 'db' | 'blobs'>,
): Promise<IngestResult> {
  const planned = await planEventWrite(db, ctx, body, env);
  if (!planned.ok) return refused(ctx, planned);
  try {
    const results = await commit(db, ...planned.write.statements);
    return planned.write.interpret(results);
  } finally {
    await planned.write.settleBody?.();
  }
}

/** What one statement of an event's batch answers: the rows it returned. */
type BatchResult = { results: unknown[] };

/** The statements one event needs, run as one batch, and how to read their answers. */
interface EventWrite {
  statements: Bound[];
  interpret(results: readonly BatchResult[]): IngestResult;
  /** Consumes a body's upload authority when its event did not store it; the caller runs it on every exit. */
  settleBody?: () => Promise<void>;
}

type PlannedWrite = { ok: true; write: EventWrite } | Refused;

/** The facts one event is admitted, read and refused by: every condition its raw insert carries is set from these. */
function captureFacts(spec: KindSpec, write: WriteContext, e: CaptureEnvelope, p: Payload, plan: KindPlan, charged: boolean): CaptureFacts {
  const named = (fields: string[]) => fields.map((field) => (typeof p[field] === 'string' ? (p[field] as string) : null));
  return {
    project: write.projectId, session: e.sessionId, machine: write.machineId, token: write.tokenId, event: e.eventId,
    charged, imported: e.channel === 'import', processing: write.processing === true,
    identities: plan.identities,
    blobs: named(blobFields(spec)),
    retainedPlan: spec.name === 'plan' && typeof p.planKey === 'string' ? p.planKey : null,
    prompts: named(promptReferenceFields(spec)),
    segment: plan.segment ?? null,
  };
}

export async function planEventWrite(
  db: RelationalStore,
  ctx: IngestContext,
  body: unknown,
  env?: Pick<ServerEnv, 'db' | 'blobs'>,
): Promise<PlannedWrite> {
  const parsed = parseEnvelope(body, ctx.now);
  if (!parsed.ok) return parsed;
  const e = parsed.value;
  // The transcript parser adapter is reserved for server-origin writes.
  if (e.producer.adapter === TRANSCRIPT_PARSE_ADAPTER && (ctx.writeOrigin ?? 'member') === 'member') {
    return {
      ok: false,
      ...refusal(
        `producer.adapter ${TRANSCRIPT_PARSE_ADAPTER} is reserved for the Deployment's transcript parser`,
        'invalid_field',
      ),
    };
  }
  const spec = kindSpec(e.kind);
  if (!spec) return { ok: false, ...refusal(`unknown kind ${e.kind}`, 'unknown_kind') };
  const payload = parsePayload(spec, e.payload, ctx.now);
  if (!payload.ok) return payload;
  const p = payload.value;

  const write: WriteContext = {
    projectId: ctx.projectId,
    tokenId: ctx.tokenId,
    machineId: ctx.machineId,
    now: ctx.now,
    nonce: crypto.randomUUID(),
    actor: ctx.actor ?? null,
    processing: ctx.writeOrigin === 'server' && e.producer.adapter === TRANSCRIPT_PARSE_ADAPTER,
  };
  const digest = await envelopeHash(e);
  const contentHash = await contentHashOf(spec, p);
  let plan: KindPlan;
  try {
    plan = planKind(spec, { ctx: write, e, p, contentHash, envelopeHash: digest });
  } catch (error) {
    if (!(error instanceof RecordSchemeError) || error.code !== 'record_identity_scheme_unsupported') throw error;
    return { ok: false, ...refusal('Record identity scheme is unsupported', error.code) };
  }
  // A server-origin write is counted nothing and consults no credential's
  // liveness: the bytes it derives from were accepted and counted when the
  // member shipped them, and that member's credential rotates on its own
  // schedule. The admission keeps one shape either way: the liveness
  // condition is switched off, so the raw insert and the same-batch read stay
  // one expression.
  const charged = (ctx.writeOrigin ?? 'member') === 'member';
  const facts = captureFacts(spec, write, e, p, plan, charged);
  const textKeys = Object.keys(DOCUMENT_TEXT_FIELDS[e.kind] ?? {}).flatMap(field => typeof p[field] === 'string' ? [p[field] as string] : []);
  const overCeiling = e.payloadBytes.byteLength > EVENT_INLINE_PAYLOAD_BYTES;
  let eventBody: EventBody | undefined;
  if (textKeys.length > 0 || overCeiling) {
    const permitted = await first(db, eventAdmitted(spec, facts));
    if (permitted !== null) {
      if (env === undefined) throw new StorageContractError('Document text or payload body admission requires a content store');
      for (const key of new Set(textKeys)) {
        try { await documentText(env, ctx.projectId, key); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'content_text_invalid') throw error;
          return { ok: false, ...refusal('Referenced document text must be valid UTF-8', 'invalid_field') };
        }
      }
      // A refused or duplicate event never reaches here: only an event about to be stored puts bytes in the store.
      if (overCeiling) eventBody = await prepareEventBody(env, {
        projectId: ctx.projectId, sessionId: e.sessionId, eventId: e.eventId, tokenId: ctx.tokenId, envelopeHash: digest, nonce: write.nonce,
        payload: e.payloadBytes as Uint8Array<ArrayBuffer>,
      }, ctx.now) ?? undefined;
    }
  }

  const raw = rawEventInsert(spec, facts, {
    kind: e.kind, channel: e.channel, payload: eventBody === undefined ? e.payloadJson : retainedEventPayload(e.payload),
    payloadFormat: eventBody === undefined ? 'inline' : 'blob', envelopeHash: digest, createdAt: e.createdAt, receivedAt: ctx.now,
    producerAdapter: e.producer.adapter, producerVersion: e.producer.version, blobKey: spilledKey(spec, p), payloadBytes: e.payloadBytes.byteLength,
    nonce: write.nonce, actor: write.actor,
  }, eventBody === undefined ? null : { key: eventBody.key, size: eventBody.size, generation: eventBody.generation, reservation: eventBody.upload?.reservation ?? null });

  const counted = chargeStoredBytes(charged, ctx.bodyBytes, ctx.tokenId);

  // A receipt records when a MEMBER last made contact. The Deployment reading
  // its own stored bytes is not contact: a parse advancing the stamp would date
  // a month-old backfilled session to now, and would hold the Deployment awake
  // on its own housekeeping. A server write still opens a session row that is
  // absent, so a derived event is never refused for want of one.
  const writer = { project: ctx.projectId, session: e.sessionId, machine: ctx.machineId, token: ctx.tokenId, event: e.eventId, nonce: write.nonce };
  const receipt = sessionReceipt(writer, { charged, now: ctx.now, createdAt: e.createdAt, agent: e.kind === 'session.start' ? (p.agent as string) : null });

  // The nonce, not a change count, decides whether THIS write stored the row: reading it back asks the store what
  // happened instead of asking the driver.
  const stored = storedEvent(ctx.projectId, e.eventId, ctx.machineId);
  const admitted = credentialStillLive(charged, ctx.tokenId);
  const checks = captureChecks(spec, facts);
  const priors = plan.priors ?? [];
  // Beside the projections in the batch, outside the evidence a conflict is read from.
  // A turn's end moves the session's last turn end and closes its open turn, unless the turn started after it.
  const turnEnd = endsTurn(e, ctx.turnEnd === true, p)
    ? [endTurn({ projectId: ctx.projectId, sessionId: e.sessionId, eventId: e.eventId, endedAt: e.createdAt, nonce: write.nonce })]
    : [];
  // A turn start opens the session's turn at its own instant, after the receipt has opened the session row it names.
  const startedAt = turnStartFrom(e, p, ctx.now);
  const turnStart = startedAt === null
    ? []
    : [startTurnFromEvent({ projectId: ctx.projectId, sessionId: e.sessionId, machineId: ctx.machineId, at: startedAt, eventId: e.eventId, nonce: write.nonce })];
  const liveCapture = e.channel === 'import' ? [] : [liveReceipt(writer, ctx.now)];
  const incidental = [
    ...(plan.incidental ?? []),
    ...turnEnd,
    ...turnStart,
    ...liveCapture,
    ...deliveryStatements(write, e, p),
    ...(eventBody === undefined ? [] : eventBodyStatements(eventBody, ctx.now)),
  ];
  const statements: Bound[] = [
    raw,
    counted,
    receipt,
    ...priors,
    ...plan.projections,
    ...incidental,
    stored,
    admitted,
    ...checks.map((c) => c.read),
    ...plan.reads,
    ...(eventBody === undefined ? [] : [eventBodyHeldRead(eventBody)]),
  ];

  let landed = false;
  const interpret = (results: readonly BatchResult[]): IngestResult => {
    if (results.length !== statements.length)
      throw new StorageContractError(`batch answered ${results.length} results for ${statements.length} statements`);

    const base = 3 + priors.length;
    const priorRows: ReadRows = results.slice(3, base).map((r) => r.results as Record<string, unknown>[]);
    const projectionResults = results.slice(base, base + plan.projections.length);
    const afterWrites = base + plan.projections.length + incidental.length;
    const storedRow = results[afterWrites]!.results[0] as { envelope_hash?: string; ingest_nonce?: string } | undefined;
    const liveRow = results[afterWrites + 1]!.results[0] as { live: number } | undefined;
    const allReads: ReadRows = results.slice(afterWrites + 2).map((r) => r.results as Record<string, unknown>[]);
    const sharedRows = allReads.slice(0, checks.length);
    const bodyRead = eventBody === undefined ? [] : allReads.slice(-1);
    const reads = allReads.slice(checks.length, allReads.length - bodyRead.length);
    const extra = plan.extra ? plan.extra(reads) : {};

    if (storedRow?.ingest_nonce === write.nonce) {
      landed = true;
      if (plan.projections.length > 0 && projectionResults.every((r) => r.results.length === 0)) {
        const reason = plan.conflict ? plan.conflict(reads) : 'projection did not apply';
        emit({ kind: 'projection_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId, eventKind: e.kind });
        return { persisted: true, projected: false, code: 'projection_conflict', reason, ...extra };
      }
      plan.landed?.(priorRows);
      emit({ kind: 'ingest_ok', projectId: ctx.projectId, tokenId: ctx.tokenId, eventKind: e.kind });
      return plan.projections.length > 0 || DOCUMENT_EVENT_KINDS.includes(e.kind)
        ? { persisted: true, projected: true, ...extra }
        : { persisted: true, ...extra };
    }
    if (storedRow) {
      if (storedRow.envelope_hash === digest) {
        emit({ kind: 'ingest_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId });
        return { persisted: true, duplicate: true, ...extra };
      }
      emit({ kind: 'ingest_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return { persisted: false, code: 'event_id_conflict', reason: 'event id conflict', ...extra };
    }
    // A body verified and then lost to the release owner or expiry can land on a retry, which this answer asks for.
    if (eventBody !== undefined && (bodyRead[0]?.[0] as { held?: number } | undefined)?.held !== 1) throw new Error('event_body_authority_lost');
    if (plan.heldDuplicate && plan.heldDuplicate(reads)) {
      emit({ kind: 'ingest_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return { persisted: true, duplicate: true, ...extra };
    }
    // A credential revoked after this request authenticated: not the caller's
    // request at fault, so no terminal refusal. The pipeline answers 503 and the
    // retry meets the revocation at authentication.
    if (liveRow?.live !== 1) throw new TokenRevokedError(ctx.tokenId);
    const sharedRefusal = checks.map((c, i) => checkRefusal(c.check, ctx.machineId, sharedRows[i]?.[0])).find((r) => r !== null) ?? null;
    return { ...refused(ctx, sharedRefusal ?? plan.refusal(reads)), ...extra };
  };

  return {
    ok: true,
    write: {
      statements,
      interpret,
      ...(eventBody === undefined ? {} : { settleBody: async () => { if (!landed) await settleUnstoredEventBody(db, eventBody!, ctx.now); } }),
    },
  };
}

/** The kind whose projected arrival, on any channel but import, asks for its session's title. */
const SESSION_END_KIND = 'session.end';
/** The channel a member ships pre-existing bytes on; an end arriving over it asks for no title. */
const IMPORT_CHANNEL = 'import';
/** The kind whose projected arrival leaves the Deployment bytes to read. */
const TRANSCRIPT_SEGMENT_KIND = 'transcript.segment';

export async function handleEvents(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return Response.json(refused(ctx, refusal('body must be JSON', 'parse')));
  }
  const result = await ingestEvent(env.db, ctx, parsed, env);
  const envelope = parsed as {
    kind?: unknown;
    sessionId?: unknown;
    channel?: unknown;
    payload?: { blob?: unknown };
  } | null;
  if (result.persisted && result.projected === true && typeof envelope?.payload?.blob === 'string') {
    env.afterResponse(async () => {
      try {
        if (await searchBlobsDue(env.db, Date.now())) await env.wake?.();
      } catch {
        emit({ kind: 'search_wake_failed', projectId: ctx.projectId });
      }
    });
  }
  // Segment bytes are unread until a pass reads them; the clock is nudged so
  // the rows appear on the next wake rather than at the next idle cadence.
  if (result.persisted && result.projected === true && envelope?.kind === TRANSCRIPT_SEGMENT_KIND) {
    env.afterResponse(async () => {
      try {
        await env.wake?.();
      } catch {
        emit({ kind: 'transcript_wake_failed', projectId: ctx.projectId });
      }
    });
  }
  // A live end asks for a title, which a wake takes once the session has
  // settled; the clock is nudged so a Deployment asleep wakes into the active
  // cadence and takes it then, rather than at its floor.
  if (
    result.persisted &&
    result.projected === true &&
    envelope?.kind === SESSION_END_KIND &&
    envelope.channel !== IMPORT_CHANNEL
  ) {
    env.afterResponse(async () => {
      try {
        await env.wake?.();
      } catch {
        emit({ kind: 'title_wake_failed', projectId: ctx.projectId });
      }
    });
  }
  return Response.json(result);
}
