/**
 * What admits one captured event, as fixed statements: one raw insert and one pre-admission read per kind, each
 * defined once at module load. Every condition a request may or may not carry (credential liveness, the import switch,
 * a referenced blob, a referenced prompt, an event body) sits in the statement behind a bound switch, so one name per
 * kind admits every request of that kind. The reads that explain a refusal are separate fixed statements, listed by
 * `captureChecks` in the order the conditions are admitted, from the same facts that set the switches.
 */
import { importEnabledChecks } from '../../core/import-policy.js';
import { blobFields, KINDS, promptReferenceFields, type KindSpec } from '../../ingest/kinds.js';
import { DOCUMENT_IDENTITIES_SQL } from '../document-tables.js';
import { TOKEN_LIVE } from '../identity/capture-credential.js';
import { read, write, type BindValue, type Bound } from '../index.js';
import { processedResourceProofSql } from '../processed-resources.js';
import { rawMemberResourceSql } from '../raw/resources.js';
import { NOT_TOMBSTONED_PARAMS } from '../session-read-model.js';
import { Slots } from './slots.js';

/** A table whose rows a machine owns: by the row's own `machine_id`, or by the session the row belongs to. */
interface OwnerShape { name: string; table: string; index?: string; keyColumn: string; owner: 'row' | 'session' }

const SESSION_ROW: OwnerShape = { name: 'session', table: 'sessions', keyColumn: 'session_id', owner: 'row' };
const ATTACHMENT: OwnerShape = { name: 'attachment', table: 'attachments', keyColumn: 'attachment_id', owner: 'session' };
const TRANSCRIPT: OwnerShape = { name: 'transcript', table: 'transcripts', keyColumn: 'transcript_id', owner: 'row' };
const DOCUMENT_RECORD: OwnerShape = { name: 'documentRecord', table: DOCUMENT_IDENTITIES_SQL, keyColumn: 'record_id', owner: 'session' };
const SESSION_PROMPT: OwnerShape = { name: 'sessionPrompt', table: 'session_prompts', index: 'idx_session_prompts_prompt', keyColumn: 'prompt_id', owner: 'session' };

/** The continued rows each projection names beyond its session, in the order they are admitted, read and refused. */
const KIND_IDENTITIES: Readonly<Record<KindSpec['projection'], readonly OwnerShape[]>> = {
  raw: [], sessions: [], plans: [],
  attachments: [ATTACHMENT],
  transcript_segments: [TRANSCRIPT],
  prompt_batches: [DOCUMENT_RECORD], tool_calls: [DOCUMENT_RECORD], responses: [DOCUMENT_RECORD],
};

/** How many continued rows a kind names: its plan supplies that many identity keys, in order. */
export const kindIdentityCount = (spec: KindSpec): number => KIND_IDENTITIES[spec.projection].length;

/** What a transcript segment's raw insert additionally requires: its blob at the stated length, its offset at the held end, and a head that matches. */
export interface SegmentAdmission { blob: string; length: number; transcriptId: string; baseOffset: number; headHash: string | null }

/** An event body held whole in the object store: registered as verified, or still under this request's upload authority. */
export interface BodyAdmission { key: string; size: number; generation: string | null; reservation: string | null }

/** The request facts every admission condition and every refusal read is decided from. */
export interface CaptureFacts {
  project: string; session: string; machine: string; token: string; event: string;
  /** A member's write: its credential must still be live. A Deployment's own write consults no credential. */
  charged: boolean;
  /** An import-channel envelope, which the import switch governs. */
  imported: boolean;
  /** The Deployment's transcript parse, whose referenced blobs are its recorded input. */
  processing: boolean;
  /** The identity keys the kind's plan names, one per continued row the kind declares. */
  identities: readonly string[];
  /** Each of the kind's blob fields, in catalogue order: the key named, or null when absent. */
  blobs: readonly (string | null)[];
  /** The plan key a referenced blob may also be retained under. */
  retainedPlan: string | null;
  /** Each of the kind's prompt-reference fields, in catalogue order: the prompt named, or null when absent. */
  prompts: readonly (string | null)[];
  segment: SegmentAdmission | null;
}

/** The raw event row as stored. */
export interface RawEvent {
  kind: string; channel: string; payload: string; payloadFormat: 'inline' | 'blob'; envelopeHash: string; createdAt: number; receivedAt: number;
  producerAdapter: string; producerVersion: string; blobKey: string | null; payloadBytes: number; nonce: string; actor: string | null;
}

type Label = string;
type Values = Record<Label, BindValue>;

const importChecks = importEnabledChecks();

const ownedSql = (slots: Slots<Label>, shape: OwnerShape, key: string): string => {
  const [project, machine] = [slots.at('project'), slots.at('machine')];
  if (shape.owner === 'row') return `NOT EXISTS (SELECT 1 FROM ${shape.table} WHERE project_id = ${project} AND ${shape.keyColumn} = ${key} AND machine_id IS NOT ${machine})`;
  const source = `${shape.table} x${shape.index === undefined ? '' : ` INDEXED BY ${shape.index}`}`;
  return `NOT EXISTS (SELECT 1 FROM ${source} CROSS JOIN sessions s ON s.project_id = x.project_id AND s.session_id = x.session_id
          WHERE x.project_id = ${project} AND x.${shape.keyColumn} = ${key} AND s.machine_id IS NOT ${machine})`;
};

/** Whether a referenced blob may be named: the processing parse's own input, or bytes the member uploaded, or retained under the plan the event names. */
const blobProofSql = (slots: Slots<Label>, key: string): string => {
  const project = slots.at('project');
  const upload = rawMemberResourceSql(project, 'blob', key, `(SELECT member_id FROM member_credentials WHERE id = ${slots.at('token')})`);
  return `CASE WHEN ${slots.at('processing')} = 1 THEN 1 ELSE (${upload}
    OR CASE WHEN ${slots.at('retained')} = 1 THEN ${processedResourceProofSql(project, 'plan', slots.at('planKey'), key)} ELSE 0 END) END`;
};

/** Every condition the kind's raw row is admitted under, in the order they are read and refused. */
function admissionSql(slots: Slots<Label>, spec: KindSpec): string[] {
  const project = slots.at('project');
  const conditions = [
    `CASE WHEN ${slots.at('charged')} = 1 THEN ${slots.place(TOKEN_LIVE, ['token'])} ELSE 1 = 1 END`,
    `EXISTS (SELECT 1 FROM projects WHERE project_id = ${project} AND archived_at IS NULL)`,
    slots.place(NOT_TOMBSTONED_PARAMS, ['project', 'session']),
    `CASE WHEN ${slots.at('imported')} = 1 THEN ${slots.place(importChecks.admission.sql, ['importLeaf', 'importOff'])} ELSE 1 END`,
    ownedSql(slots, SESSION_ROW, slots.at('session')),
    ...KIND_IDENTITIES[spec.projection].map((shape, index) => ownedSql(slots, shape, slots.at(`identity${index}`))),
    ...blobFields(spec).map((_, index) => {
      const key = slots.at(`blob${index}`);
      return `CASE WHEN ${slots.at(`blobOn${index}`)} = 1 THEN EXISTS (SELECT 1 FROM blobs WHERE project_id = ${project} AND key = ${key} AND ${blobProofSql(slots, key)}) ELSE 1 END`;
    }),
    ...promptReferenceFields(spec).map((_, index) => {
      const key = slots.at(`prompt${index}`);
      return `CASE WHEN ${slots.at(`promptOn${index}`)} = 1 THEN (${ownedSql(slots, SESSION_PROMPT, key)} AND ${ownedSql(slots, DOCUMENT_RECORD, key)}) ELSE 1 END`;
    }),
  ];
  if (spec.projection !== 'transcript_segments') return conditions;
  const [transcript, offset, head] = [slots.at('transcript'), slots.at('baseOffset'), slots.at('headHash')];
  return [...conditions,
    `EXISTS (SELECT 1 FROM blobs WHERE project_id = ${project} AND key = ${slots.at('segmentBlob')} AND size = ${slots.at('segmentLength')})`,
    `COALESCE((SELECT size FROM transcripts WHERE project_id = ${project} AND transcript_id = ${transcript}), 0) = ${offset}`,
    `NOT EXISTS (SELECT 1 FROM transcripts WHERE project_id = ${project} AND transcript_id = ${transcript} AND head_hash IS NOT NULL AND ${head} IS NOT NULL AND head_hash <> ${head})`,
  ];
}

/** A body's admission: none, still registered as it was verified, or still under this request's upload authority. */
const bodySql = (slots: Slots<Label>): string => {
  const [project, key, size] = [slots.at('project'), slots.at('bodyKey'), slots.at('bodySize')];
  return `CASE ${slots.at('bodyMode')} WHEN 0 THEN 1
    WHEN 1 THEN EXISTS (SELECT 1 FROM blobs WHERE project_id = ${project} AND key = ${key} AND generation IS ${slots.at('bodyGeneration')} AND size = ${size})
    ELSE EXISTS (SELECT 1 FROM blob_reservations WHERE reservation_id = ${slots.at('bodyReservation')} AND project_id = ${project} AND key = ${key} AND size = ${size}) END`;
};

const RAW_COLUMNS = ['project_id', 'event_id', 'session_id', 'token_id', 'kind', 'channel', 'payload', 'payload_format', 'envelope_hash', 'created_at',
  'received_at', 'producer_adapter', 'producer_version', 'blob_key', 'payload_bytes', 'ingest_nonce', 'actor'] as const;
const RAW_LABELS: Readonly<Record<(typeof RAW_COLUMNS)[number], Label>> = {
  project_id: 'project', event_id: 'event', session_id: 'session', token_id: 'token', kind: 'kind', channel: 'channel', payload: 'payload',
  payload_format: 'payloadFormat', envelope_hash: 'envelopeHash', created_at: 'createdAt', received_at: 'receivedAt', producer_adapter: 'producerAdapter',
  producer_version: 'producerVersion', blob_key: 'blobKey', payload_bytes: 'payloadBytes', ingest_nonce: 'nonce', actor: 'actor',
};
const INTEGER_COLUMNS: ReadonlySet<string> = new Set(['created_at', 'received_at', 'payload_bytes']);

interface KindStatements {
  slots: { raw: Slots<Label>; admitted: Slots<Label> };
  raw: ReturnType<typeof write<BindValue[]>>;
  admitted: ReturnType<typeof read<BindValue[], { admitted: number }>>;
}

/** A kind's name as one statement-name segment: `session.start` is `sessionStart`. */
const nameSegment = (kind: string): string =>
  kind.split(/[^A-Za-z0-9]+/).filter(part => part !== '').map((part, index) => index === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join('');

const BY_KIND: ReadonlyMap<string, KindStatements> = new Map(KINDS.map((spec): [string, KindStatements] => {
  const raw = new Slots<Label>();
  const values = RAW_COLUMNS.map(column => INTEGER_COLUMNS.has(column) ? `CAST(${raw.at(RAW_LABELS[column])} AS INTEGER)` : raw.at(RAW_LABELS[column]));
  const rawSql = `INSERT INTO events (${RAW_COLUMNS.join(',')})
      SELECT ${values.join(', ')} WHERE ${[...admissionSql(raw, spec), bodySql(raw)].map(condition => `(${condition})`).join(' AND ')}
      ON CONFLICT(project_id,event_id) DO NOTHING`;
  const admitted = new Slots<Label>();
  const admittedSql = `SELECT 1 AS admitted WHERE ${admissionSql(admitted, spec).map(condition => `(${condition})`).join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM events WHERE project_id=${admitted.at('project')} AND event_id=${admitted.at('event')})`;
  const segment = nameSegment(spec.name);
  return [spec.name, {
    slots: { raw, admitted },
    raw: write<BindValue[]>({ name: `capture.rawInsert.${segment}`, sql: rawSql }),
    admitted: read<BindValue[], { admitted: number }>({ name: `capture.admitted.${segment}`, sql: admittedSql }),
  }];
}));

const statementsOf = (spec: KindSpec): KindStatements => {
  const held = BY_KIND.get(spec.name);
  if (held === undefined) throw new Error(`no capture statements for kind ${spec.name}`);
  return held;
};

const flag = (value: boolean): number => (value ? 1 : 0);

function admissionValues(spec: KindSpec, facts: CaptureFacts): Values {
  const shapes = KIND_IDENTITIES[spec.projection];
  if (facts.identities.length !== shapes.length) throw new Error(`kind ${spec.name} names ${shapes.length} continued rows; the plan gave ${facts.identities.length}`);
  if (facts.blobs.length !== blobFields(spec).length || facts.prompts.length !== promptReferenceFields(spec).length) {
    throw new Error(`kind ${spec.name}: blob and prompt references must follow the catalogue's fields`);
  }
  const segment = facts.segment;
  if ((spec.projection === 'transcript_segments') !== (segment !== null)) throw new Error(`kind ${spec.name}: a segment admission belongs to transcript segments alone`);
  const [importLeaf, importOff] = importChecks.admission.params;
  return {
    project: facts.project, session: facts.session, machine: facts.machine, token: facts.token, event: facts.event,
    charged: flag(facts.charged), imported: flag(facts.imported), importLeaf: importLeaf!, importOff: importOff!,
    processing: flag(facts.processing), retained: flag(facts.retainedPlan !== null), planKey: facts.retainedPlan,
    ...Object.fromEntries(facts.identities.map((key, index) => [`identity${index}`, key])),
    ...Object.fromEntries(facts.blobs.flatMap((key, index) => [[`blob${index}`, key], [`blobOn${index}`, flag(key !== null)]])),
    ...Object.fromEntries(facts.prompts.flatMap((key, index) => [[`prompt${index}`, key], [`promptOn${index}`, flag(key !== null)]])),
    ...(segment === null ? {} : {
      segmentBlob: segment.blob, segmentLength: segment.length, transcript: segment.transcriptId, baseOffset: segment.baseOffset, headHash: segment.headHash,
    }),
  };
}

const integer = (value: number): number => {
  if (!Number.isSafeInteger(value)) throw new Error('material_integer_invalid');
  return value;
};

/** The raw row's insert, which stores it only when every admission holds and the body, if any, still stands; a duplicate id writes nothing. */
export function rawEventInsert(spec: KindSpec, facts: CaptureFacts, event: RawEvent, body: BodyAdmission | null): Bound {
  const { raw, slots } = { raw: statementsOf(spec).raw, slots: statementsOf(spec).slots.raw };
  return raw.bind(...slots.values({
    ...admissionValues(spec, facts),
    kind: event.kind, channel: event.channel, payload: event.payload, payloadFormat: event.payloadFormat, envelopeHash: event.envelopeHash,
    createdAt: integer(event.createdAt), receivedAt: integer(event.receivedAt), producerAdapter: event.producerAdapter, producerVersion: event.producerVersion,
    blobKey: event.blobKey, payloadBytes: integer(event.payloadBytes), nonce: event.nonce, actor: event.actor,
    bodyMode: body === null ? 0 : body.reservation === null ? 1 : 2,
    bodyKey: body?.key ?? null, bodySize: body?.size ?? null, bodyGeneration: body?.generation ?? null, bodyReservation: body?.reservation ?? null,
  }));
}

/** Whether every admission holds and no row holds the event id yet: read before any body is put in the object store. */
export function eventAdmitted(spec: KindSpec, facts: CaptureFacts): Bound<{ admitted: number }, 'read'> {
  const { admitted, slots } = { admitted: statementsOf(spec).admitted, slots: statementsOf(spec).slots.admitted };
  return admitted.bind(...slots.values(admissionValues(spec, facts)));
}

type CheckRow = Record<string, unknown>;
const ownerRead = (shape: OwnerShape) => read<[project: string, key: string], CheckRow>({ name: `capture.ownerOf.${shape.name}`, sql: shape.owner === 'row'
  ? `SELECT machine_id FROM ${shape.table} WHERE project_id = ?1 AND ${shape.keyColumn} = ?2`
  : `SELECT s.machine_id FROM ${shape.table} x${shape.index === undefined ? '' : ` INDEXED BY ${shape.index}`}
      CROSS JOIN sessions s ON s.project_id = x.project_id AND s.session_id = x.session_id WHERE x.project_id = ?1 AND x.${shape.keyColumn} = ?2` });
const OWNER_READS = new Map([SESSION_ROW, ATTACHMENT, TRANSCRIPT, DOCUMENT_RECORD, SESSION_PROMPT].map(shape => [shape, ownerRead(shape)]));
const projectRead = read<[project: string], CheckRow>({ name: 'capture.projectArchived', sql: 'SELECT archived_at FROM projects WHERE project_id = ?1' });
const tombstoneRead = read<[project: string, session: string], CheckRow>({ name: 'capture.sessionTombstone', sql:
  'SELECT 1 AS tombstoned FROM session_tombstones WHERE project_id = ?1 AND session_id = ?2' });
const importSlots = new Slots<Label>();
const importRead = read<BindValue[], CheckRow>({ name: 'capture.importDisabled', sql: importSlots.place(importChecks.read.sql, ['leaf', 'off']) });
const blobSlots = new Slots<Label>();
const blobRead = read<BindValue[], CheckRow>({ name: 'capture.blobPresent', sql:
  `SELECT media_type FROM blobs WHERE project_id = ${blobSlots.at('project')} AND key = ${blobSlots.at('blob')} AND ${blobProofSql(blobSlots, blobSlots.at('blob'))}` });

/** Which admission a refusal read explains: the reader decides the refusal from the read's first row. */
export type CaptureCheck = { check: 'project' } | { check: 'tombstone' } | { check: 'import' } | { check: 'owner' } | { check: 'blob'; key: string };

const owner = (shape: OwnerShape, project: string, key: string) => ({ check: { check: 'owner' } as CaptureCheck, read: OWNER_READS.get(shape)!.bind(project, key) });

/** The tombstone and session-ownership reads that explain why a write naming a session is held back, in the order they refuse. */
export function sessionChecks(project: string, session: string): { check: CaptureCheck; read: Bound<CheckRow, 'read'> }[] {
  return [
    { check: { check: 'tombstone' }, read: tombstoneRead.bind(project, session) },
    owner(SESSION_ROW, project, session),
  ];
}

/** The reads that explain a refused event, one per admission the request carries, in the order the admissions are refused. */
export function captureChecks(spec: KindSpec, facts: CaptureFacts): { check: CaptureCheck; read: Bound<CheckRow, 'read'> }[] {
  const [leaf, off] = importChecks.read.params;
  const [tombstone, session] = sessionChecks(facts.project, facts.session);
  return [
    { check: { check: 'project' }, read: projectRead.bind(facts.project) },
    tombstone!,
    ...(facts.imported ? [{ check: { check: 'import' } as CaptureCheck, read: importRead.bind(...importSlots.values({ leaf: leaf!, off: off! })) }] : []),
    session!,
    ...KIND_IDENTITIES[spec.projection].map((shape, index) => owner(shape, facts.project, facts.identities[index]!)),
    ...facts.blobs.flatMap(key => key === null ? [] : [{
      check: { check: 'blob', key } as CaptureCheck,
      read: blobRead.bind(...blobSlots.values({ project: facts.project, blob: key, token: facts.token, processing: flag(facts.processing),
        retained: flag(facts.retainedPlan !== null), planKey: facts.retainedPlan })),
    }]),
    ...facts.prompts.flatMap(key => key === null ? [] : [owner(SESSION_PROMPT, facts.project, key), owner(DOCUMENT_RECORD, facts.project, key)]),
  ];
}
