/**
 * Bringing a 1.4 vault's history to a Deployment.
 *
 * A 1.4 vault holds what no transcript on disk still holds: sessions whose
 * transcripts the harness pruned, the titles 1.4 gave every session, and the
 * spores and plans that were curated from them. This reads a vault and sends
 * it through the routes live capture and the tools already write through —
 * `/events` for sessions, prompts and plans, `/spores/save` and
 * `/spores/resolve` for spores and their lineage — so it adds no second way
 * for a row to reach a Deployment.
 *
 * **One session id space.** A vault row's id becomes the id the harness's
 * transcript layout names for the same session (`legacySessionId`), so a
 * session the vault holds and a transcript on disk records land as one.
 *
 * **One content source per session, decided once.** Its transcript, where a
 * file is on disk under any harness's layout or the Deployment already holds
 * one; the vault's prompts and responses only where neither is true. The
 * decision is recorded before anything is sent (`LegacyLedger`), so a rerun
 * and every later transcript import honour it. A session the Deployment
 * already holds keeps the facts and the end live capture recorded: it gets
 * the vault's title alone.
 *
 * **Every write is idempotent.** Event ids derive from the vault row, the
 * producer is fixed, and every instant is the vault's, so a second run sends
 * byte-identical envelopes the Deployment answers as duplicates. Spores and
 * lineage keep their 1.4 ids and times.
 *
 * **What is left out is read from the vault on every run.** A session a person
 * deleted in 1.4 is left out of this import and of the transcript import
 * after it; a session another machine captured is that machine's to import.
 * A refusal the Deployment makes is reported, and the session it refused is
 * never recorded as done.
 *
 * The vault is opened read-only and is never written.
 */
import { Database } from 'bun:sqlite';
import { LEGACY_MINTED_ID } from '@goondocks/myco-shared/session-ids';
import fs from 'node:fs';
import path from 'node:path';
import { enumerateTranscripts, manifestTranscriptDiscovery, findTranscriptFor, sessionIdFromStoredId, sessionIdFromTranscriptPath } from '../symbionts/transcript-discovery.js';
import { canonicalPath, transcriptPlacer, transcriptTimeSpan } from '../symbionts/transcript-attribution.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { resolveMycoHome } from '../paths/home.js';
import { legacyVaultFiles } from './home-role.js';
import { unboundedBudget } from './budget.js';
import {
  deriveId, planEvent, planKeyForPath, promptEvent, responseEvent, sessionEndEvent, sessionStartEvent, sessionTitleEvent,
  type EnvelopeContext, type OutboundEvent,
} from './envelope.js';
import {
  observedFetch, paced, pause, retryVerdict, retryWaitMs, shipSession, transcriptCandidate, IMPORT_MAX_PASSES, IMPORT_WAIT_CAP_MS, SERVER_FAULT_RETRIES,
  type Candidate,
} from './import.js';
import { LegacyLedger, type ContentSource } from './legacy-ledger.js';
import { normalizePlanPath } from './plan-files.js';
import { deploymentUrl, listDeploymentMemberships, type DeploymentMembership } from './registry.js';
import { MemberSpool, type RefusedEntry } from './spool.js';
import { ServerClient, type FetchLike, type Outcome } from './transport.js';
import { REFUSAL_SUBJECT } from './constants.js';
import { LEGACY_IMPORT_ADAPTER, PLAN_STATUSES, type PlanStatus } from '@goondocks/myco-shared/member-protocol';
import type { PromptOrigin } from '@goondocks/myco-shared/capture-rules';

/** The producer every envelope this import sends names. Fixed, so a rebuilt binary re-sends envelopes the Deployment reads as the ones it holds. */
export const LEGACY_PRODUCER = { adapter: LEGACY_IMPORT_ADAPTER, version: '1' } as const;
/** The furthest back a plan for a vault session's transcript reaches, and the most per agent: the Deployment's ceilings, since the vault already bounds what is offered. */
export const LEGACY_WINDOW_DAYS = 3650;
export const LEGACY_MAX_PER_AGENT = 1000;
/** Session ids one probe of the Deployment names; the plan route's candidate ceiling. */
const PROBE_CHUNK = 1000;
/** A 1.4 instant below this is seconds; at or above it, milliseconds. */
const MS_FLOOR = 100_000_000_000;
const SPORES_SAVE_PATH = '/spores/save';
const SPORES_RESOLVE_PATH = '/spores/resolve';

export interface LegacySession {
  id: string;
  agent: string;
  projectRoot: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  title: string | null;
  summary: string | null;
  transcriptPath: string | null;
  parentSessionId: string | null;
  parentReason: string | null;
  /** The machine that captured the session, as 1.4 recorded it; null where it recorded none. */
  machineId: string | null;
}

export interface LegacyPrompt {
  id: string;
  sessionId: string;
  parentId: string | null;
  kind: string | null;
  origin: string | null;
  text: string | null;
  response: string | null;
  startedAt: number | null;
  endedAt: number | null;
  threadId: string | null;
  threadLabel: string | null;
}

export interface LegacyPlan {
  id: string;
  sessionId: string | null;
  logicalKey: string | null;
  status: string | null;
  title: string | null;
  content: string | null;
  sourcePath: string | null;
  tags: string | null;
  promptId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface LegacySpore {
  id: string;
  agentId: string;
  sessionId: string | null;
  promptId: string | null;
  observationType: string;
  status: string;
  content: string;
  context: string | null;
  importance: number | null;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  createdAt: number | null;
}

export interface LegacyResolution {
  id: string;
  agentId: string;
  sporeId: string;
  action: string;
  newSporeId: string | null;
  reason: string | null;
  sessionId: string | null;
  createdAt: number | null;
}

/** One 1.4 project's rows, as its vault holds them. */
export interface LegacyProject {
  projectId: string;
  vault: string;
  sessions: LegacySession[];
  prompts: LegacyPrompt[];
  plans: LegacyPlan[];
  spores: LegacySpore[];
  resolutions: LegacyResolution[];
  /** Stored ids a person deleted in 1.4 (`api_delete`): left out of every import. */
  deleted: Set<string>;
  /** Stored ids 1.4 tombstoned for its own reasons (a sweep, a capture it judged invalid, a phantom): not imported from the vault, and no bar to a transcript. */
  retired: Set<string>;
}

/** The machine id 1.4 recorded where it knew none: a row the importing machine takes as its own. */
export const LEGACY_UNATTRIBUTED_MACHINE = 'local';

/** The tombstone source 1.4 records when a person deletes a session. */
export const LEGACY_USER_DELETE_SOURCE = 'api_delete';

/** A 1.4 instant in milliseconds, whichever unit the row stored it in. */
export const legacyMs = (value: number | null | undefined): number | null =>
  typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ? null : value < MS_FLOOR ? Math.trunc(value * 1000) : Math.trunc(value);

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (v: unknown): string => String(v);

/** Every project a vault holds rows for, read through a read-only handle. */
export function readLegacyVault(file: string): LegacyProject[] {
  const db = new Database(file, { readonly: true });
  try {
    const columns = (table: string): Set<string> =>
      new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    const has = (table: string): boolean => columns(table).size > 0;
    const rows = (sql: string): Array<Record<string, unknown>> => db.query(sql).all() as Array<Record<string, unknown>>;

    const projects = new Map<string, LegacyProject>();
    const project = (id: unknown): LegacyProject => {
      const key = idOf(id);
      let held = projects.get(key);
      if (held === undefined) {
        held = { projectId: key, vault: file, sessions: [], prompts: [], plans: [], spores: [], resolutions: [], deleted: new Set(), retired: new Set() };
        projects.set(key, held);
      }
      return held;
    };

    for (const r of rows(`SELECT * FROM sessions WHERE project_id IS NOT NULL ORDER BY started_at, id`)) {
      project(r.project_id).sessions.push({
        id: idOf(r.id), agent: text(r.agent) ?? 'unknown', projectRoot: text(r.project_root), branch: text(r.branch),
        startedAt: legacyMs(num(r.started_at)), endedAt: legacyMs(num(r.ended_at)), title: text(r.title), summary: text(r.summary),
        transcriptPath: text(r.transcript_path), parentSessionId: text(r.parent_session_id), parentReason: text(r.parent_session_reason),
        machineId: text(r.machine_id),
      });
    }
    for (const r of rows(`SELECT * FROM prompt_batches WHERE project_id IS NOT NULL ORDER BY started_at, id`)) {
      project(r.project_id).prompts.push({
        id: idOf(r.id), sessionId: idOf(r.session_id), parentId: r.parent_prompt_batch_id == null ? null : idOf(r.parent_prompt_batch_id),
        kind: text(r.kind), origin: text(r.origin), text: text(r.user_prompt), response: text(r.response_summary),
        startedAt: legacyMs(num(r.started_at) ?? num(r.created_at)), endedAt: legacyMs(num(r.ended_at)),
        threadId: text(r.thread_id), threadLabel: text(r.thread_label),
      });
    }
    for (const r of rows(`SELECT * FROM plans WHERE project_id IS NOT NULL ORDER BY updated_at, id`)) {
      project(r.project_id).plans.push({
        id: idOf(r.id), sessionId: text(r.session_id), logicalKey: text(r.logical_key), status: text(r.status), title: text(r.title),
        content: text(r.content), sourcePath: text(r.source_path), tags: text(r.tags),
        promptId: r.prompt_batch_id == null ? null : idOf(r.prompt_batch_id),
        createdAt: legacyMs(num(r.created_at)), updatedAt: legacyMs(num(r.updated_at)),
      });
    }
    for (const r of rows(`SELECT * FROM spores WHERE project_id IS NOT NULL ORDER BY created_at, id`)) {
      project(r.project_id).spores.push({
        id: idOf(r.id), agentId: text(r.agent_id) ?? 'user', sessionId: text(r.session_id),
        promptId: r.prompt_batch_id == null ? null : idOf(r.prompt_batch_id),
        observationType: text(r.observation_type) ?? 'discovery', status: text(r.status) ?? 'active', content: text(r.content) ?? '',
        context: text(r.context), importance: num(r.importance), filePath: text(r.file_path), tags: text(r.tags),
        contentHash: text(r.content_hash), properties: text(r.properties), createdAt: legacyMs(num(r.created_at)),
      });
    }
    if (has('resolution_events')) {
      for (const r of rows(`SELECT * FROM resolution_events WHERE project_id IS NOT NULL ORDER BY created_at, id`)) {
        project(r.project_id).resolutions.push({
          id: idOf(r.id), agentId: text(r.agent_id) ?? 'user', sporeId: idOf(r.spore_id), action: idOf(r.action),
          newSporeId: text(r.new_spore_id), reason: text(r.reason), sessionId: text(r.session_id), createdAt: legacyMs(num(r.created_at)),
        });
      }
    }
    if (has('session_tombstones')) {
      const sourced = columns('session_tombstones').has('source');
      for (const r of rows(`SELECT * FROM session_tombstones WHERE project_id IS NOT NULL`)) {
        const into = sourced && r.source === LEGACY_USER_DELETE_SOURCE ? project(r.project_id).deleted : project(r.project_id).retired;
        into.add(idOf(r.session_id));
      }
    }
    return [...projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  } finally {
    db.close();
  }
}

/** Every harness whose layout names transcripts, the one given first. */
const harnessesFrom = (first: string): string[] => [first, ...Object.keys(HOOK_CONFIG).filter((a) => a !== first && manifestTranscriptDiscovery(a) !== undefined).sort()];

/**
 * The harness session a vault row names, and the harness that wrote it: the
 * one a recorded transcript path's layout yields (any harness's layout, the
 * recorded agent's first, since 1.4 recorded some sessions under another
 * harness's name), else the one the recorded agent's id shape finds in the
 * stored id, else the stored id under the recorded agent.
 */
export function legacyIdentity(agent: string, storedId: string, transcriptPath: string | null): { sessionId: string; agent: string } {
  if (transcriptPath !== null) {
    for (const harness of harnessesFrom(agent)) {
      const byPath = sessionIdFromTranscriptPath(manifestTranscriptDiscovery(harness), transcriptPath);
      if (byPath !== null) return { sessionId: byPath, agent: harness };
    }
  }
  return { sessionId: sessionIdFromStoredId(manifestTranscriptDiscovery(agent), storedId) ?? storedId, agent };
}

/** The harness session id alone; see `legacyIdentity`. */
export const legacySessionId = (agent: string, storedId: string, transcriptPath: string | null): string =>
  legacyIdentity(agent, storedId, transcriptPath).sessionId;

/** The transcript on disk for a session, under the harness that wrote it: the recorded path when it names this session, else wherever any harness's layout puts it. */
export function locateTranscript(agent: string, sessionId: string, recordedPath: string | null): { agent: string; file: string } | null {
  if (recordedPath !== null && fs.existsSync(recordedPath)) {
    for (const harness of harnessesFrom(agent)) {
      if (sessionIdFromTranscriptPath(manifestTranscriptDiscovery(harness), recordedPath) === sessionId) return { agent: harness, file: recordedPath };
    }
  }
  for (const harness of harnessesFrom(agent)) {
    const file = findTranscriptFor(harness, sessionId);
    if (file !== null) return { agent: harness, file };
  }
  return null;
}

/** The ids one vault row's derived events and rows take, all under this Project. */
const legacyId = (projectId: string, ...parts: string[]): string => deriveId('legacy', projectId, ...parts);
export const legacyPromptId = (projectId: string, promptId: string): string => legacyId(projectId, 'prompt', promptId);

/** The key a vault plan takes: the member's key for its file, the tool's key for its logical key, else one derived from its row. */
export function legacyPlanKey(projectId: string, root: string | null, plan: LegacyPlan): { planKey: string; originPath?: string } {
  if (plan.sourcePath !== null && root !== null) {
    const normalized = normalizePlanPath(root, path.resolve(root, plan.sourcePath));
    return { planKey: planKeyForPath(projectId, normalized), originPath: normalized };
  }
  const keyed = plan.logicalKey === null ? null : /^session:[^:]+:key:(.+)$/.exec(plan.logicalKey);
  if (keyed !== null) return { planKey: deriveId('plan-key', projectId, keyed[1]) };
  return { planKey: legacyId(projectId, 'plan', plan.id) };
}

/**
 * A harness session and every vault row that names it. The later-started row
 * supplies the facts; the title, summary and prompts are the first row's, in
 * that order, that has them, so no row's record is dropped for another's gap.
 */
export interface SessionGroup {
  sessionId: string;
  agent: string;
  winner: LegacySession;
  storedIds: string[];
  title: string | null;
  summary: string | null;
  /** The stored id whose prompt rows are the session's. */
  promptsFrom: string;
}

/** Order rows latest-started first: the order a group's fields are taken in. */
const byStartDesc = (a: LegacySession, b: LegacySession): number => (b.startedAt ?? 0) - (a.startedAt ?? 0);

function groupOf(sessionId: string, agent: string, rows: LegacySession[], promptCount: Map<string, number>): SessionGroup {
  const ordered = [...rows].sort(byStartDesc);
  return {
    sessionId, agent, winner: ordered[0], storedIds: ordered.map((r) => r.id),
    title: ordered.find((r) => r.title !== null)?.title ?? null,
    summary: ordered.find((r) => r.summary !== null)?.summary ?? null,
    promptsFrom: ordered.find((r) => (promptCount.get(r.id) ?? 0) > 0)?.id ?? ordered[0].id,
  };
}

/** A project's vault sessions as the import sends them, and what it leaves out. */
export interface LegacyGrouping {
  groups: SessionGroup[];
  /** Every stored id's harness session id. */
  idOf: Map<string, string>;
  /**
   * Session ids a person deleted in 1.4, left out of every import: each deleted
   * stored id and the harness id it resolves to, unless another row of the
   * same session survives.
   */
  deleted: Set<string>;
  /** Each deleted stored id left out, with every session id it may be held under: itself and each harness id it resolves to. */
  deletedSessions: Map<string, string[]>;
  /** Stored ids deleted in 1.4 that no harness layout resolves a session for: reported, since a transcript of one could still be imported. */
  unmatchedDeletes: string[];
  /** Rows another machine captured, by that machine: this machine does not import them. */
  otherMachines: Map<string, string[]>;
}

/** The harness session ids a stored id with no row resolves to under any layout's id shape; the stored id itself where none does. */
function resolveStoredId(storedId: string): string[] {
  const resolved = Object.keys(HOOK_CONFIG)
    .map((agent) => sessionIdFromStoredId(manifestTranscriptDiscovery(agent), storedId))
    .filter((id): id is string => id !== null);
  return [...new Set(resolved.length > 0 ? resolved : [storedId])];
}

/**
 * Vault sessions grouped by the session id each takes. A row a person deleted,
 * a row 1.4 retired and a row another machine captured are left out of its
 * group; a group survives while any row of it does, with that row's title and
 * prompts. `aliases` maps a stored id onto a harness id found another way.
 * `thisMachine` is the machine importing; a row naming another machine is its
 * to import.
 */
export function groupLegacySessions(project: LegacyProject, aliases: ReadonlyMap<string, string> = new Map(), thisMachine?: string): LegacyGrouping {
  const idOf = new Map<string, string>();
  const rowsBy = new Map<string, { agent: string; rows: LegacySession[] }>();
  const deletedRows = new Map<string, string>();
  const otherMachines = new Map<string, string[]>();
  const promptCount = new Map<string, number>();
  for (const p of project.prompts) promptCount.set(p.sessionId, (promptCount.get(p.sessionId) ?? 0) + 1);
  for (const s of project.sessions) {
    const identity = legacyIdentity(s.agent, s.id, s.transcriptPath);
    const sessionId = aliases.get(s.id) ?? identity.sessionId;
    idOf.set(s.id, sessionId);
    if (project.deleted.has(s.id)) { deletedRows.set(s.id, sessionId); continue; }
    if (project.retired.has(s.id)) continue;
    if (thisMachine !== undefined && s.machineId !== null && s.machineId !== LEGACY_UNATTRIBUTED_MACHINE && s.machineId !== thisMachine) {
      otherMachines.set(s.machineId, [...(otherMachines.get(s.machineId) ?? []), s.id]);
      continue;
    }
    const held = rowsBy.get(sessionId);
    if (held === undefined) rowsBy.set(sessionId, { agent: identity.agent, rows: [s] }); else held.rows.push(s);
  }
  const deletedSessions = new Map<string, string[]>();
  const unmatchedDeletes: string[] = [];
  for (const [storedId, sessionId] of deletedRows) {
    if (rowsBy.has(sessionId)) continue;
    deletedSessions.set(storedId, [...new Set([storedId, sessionId])]);
  }
  for (const storedId of project.deleted) {
    if (idOf.has(storedId)) continue;
    const resolved = resolveStoredId(storedId);
    if (LEGACY_MINTED_ID.test(storedId) && resolved.length === 1 && resolved[0] === storedId) unmatchedDeletes.push(storedId);
    deletedSessions.set(storedId, [...new Set([storedId, ...resolved])]);
  }
  const deleted = new Set([...deletedSessions.values()].flat());
  const groups = [...rowsBy.entries()].map(([sessionId, { agent, rows }]) => groupOf(sessionId, agent, rows, promptCount))
    .sort((a, b) => (a.winner.startedAt ?? 0) - (b.winner.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
  return { groups, idOf, deleted, deletedSessions, unmatchedDeletes: unmatchedDeletes.sort(), otherMachines };
}

/**
 * Stored ids 1.4 minted (`LEGACY_MINTED_ID`) that the layout could not name a
 * harness session for (no transcript path, no id shape in the id), tied to
 * the one transcript on disk that the
 * same harness wrote in the same project root while the session ran: the one
 * whose first record falls in the second 1.4 recorded the start, else the one
 * whose records span that instant. A stored id with no such transcript, or
 * with more than one, is reported and keeps its id: a guess would merge two
 * sessions.
 */
export function aliasByTranscriptTime(project: LegacyProject, root: string | null): { aliases: Map<string, string>; matched: string[]; unmatched: string[] } {
  const aliases = new Map<string, string>();
  const matched: string[] = [];
  const unmatched: string[] = [];
  if (root === null) return { aliases, matched, unmatched };
  const place = transcriptPlacer([root]);
  const claimed = new Set(project.sessions.map((s) => legacyIdentity(s.agent, s.id, s.transcriptPath).sessionId));
  const indexes = new Map<string, Array<{ sessionId: string; first: number; last: number }>>();
  const indexFor = (agent: string) => {
    let index = indexes.get(agent);
    if (index !== undefined) return index;
    index = [];
    for (const t of enumerateTranscripts(manifestTranscriptDiscovery(agent), 100_000)) {
      if (claimed.has(t.sessionId)) continue;
      const placed = place(agent, t.filePath);
      if (placed.kind !== 'bound') continue;
      const span = transcriptTimeSpan(t.filePath);
      if (span !== null) index.push({ sessionId: t.sessionId, ...span });
    }
    indexes.set(agent, index);
    return index;
  };
  for (const s of project.sessions) {
    if (project.deleted.has(s.id) || project.retired.has(s.id) || s.startedAt === null || !LEGACY_MINTED_ID.test(s.id)) continue;
    const identity = legacyIdentity(s.agent, s.id, s.transcriptPath);
    if (identity.sessionId !== s.id || s.transcriptPath !== null || manifestTranscriptDiscovery(s.agent) === undefined) continue;
    if (locateTranscript(s.agent, s.id, null) !== null) continue;
    const index = indexFor(s.agent);
    const second = Math.floor(s.startedAt / 1000);
    const exact = index.filter((t) => Math.floor(t.first / 1000) === second);
    const within = index.filter((t) => t.first <= s.startedAt! && s.startedAt! <= t.last + 999);
    const pick = exact.length === 1 ? exact[0] : exact.length === 0 && within.length === 1 ? within[0] : null;
    if (pick === null) { unmatched.push(`${s.id} (${s.agent}, ${exact.length + within.length === 0 ? 'no transcript' : 'several transcripts'})`); continue; }
    aliases.set(s.id, pick.sessionId);
    claimed.add(pick.sessionId);
    matched.push(`${s.id} → ${pick.sessionId} (${s.agent}, ${exact.length === 1 ? 'same start second' : 'ran at that time'})`);
  }
  return { aliases, matched, unmatched };
}

export interface LegacyProjectReport {
  projectId: string;
  root: string | null;
  vault: { sessions: number; prompts: number; plans: number; spores: number; lineage: number };
  sessions: {
    /** Distinct sessions after rows naming one session are merged. */
    distinct: number;
    /** Left out: deleted in 1.4 and not on the Deployment, or deleted on the Deployment. */
    deleted: number;
    /** Already on the Deployment: their facts and end are left as captured. */
    alreadyHeld: number;
    transcriptsShipped: number;
    transcriptsHeld: number;
    /** Sessions whose prompts and responses came from the vault. */
    fromVault: number;
    /** Finished by an earlier run, per this machine's ledger. */
    resumed: number;
  };
  /** Stored ids tied to a transcript by the time it was written; stored ids that could not be. */
  aliases: string[];
  unaliased: string[];
  /** Stored ids deleted in 1.4 that no layout resolves a session for: a transcript of one could still be imported. */
  unmatchedDeletes: string[];
  /** Sessions deleted in 1.4 that the Deployment already holds (a transcript import got there first): the owner deletes them. */
  deletedButHeld: string[];
  /** Sessions whose transcript is still being written: nothing is sent or decided for them, and a later run brings them. */
  stillWriting: string[];
  /** What a run that stopped early never reached. */
  notAttempted?: { sessions: number; spores: number; lineage: number };
  /** Sessions another machine captured, by machine: that machine imports them. */
  otherMachines: Record<string, number>;
  prompts: number;
  responses: number;
  /** Plans sent; plans with no content; plans whose session is deleted or not in the vault. */
  plans: { sent: number; empty: number; unsent: number };
  spores: { saved: number; duplicate: number; refused: number };
  lineage: { recorded: number; duplicate: number; refused: number; malformed: number };
  /** What the Deployment refused, with its reason; a session with a refusal is not recorded as done. */
  refusals: string[];
  /** Steps that could not finish (a status no retry changes, repeated server errors, too long a wait): left for a later run. */
  failures: string[];
  /** History events 1.4 recorded in a shape no Deployment takes: skipped. */
  malformed: string[];
  endedBy?: string;
}

export interface LegacyImportReport {
  serverUrl: string | null;
  projects: LegacyProjectReport[];
  /** Harness session ids 1.4 deleted, for a transcript import to leave out. */
  deleted: string[];
  refused?: string;
}

export interface LegacyImportOptions {
  /** 1.4 homes, grove directories or vault files. */
  sources: readonly string[];
  serverUrl?: string;
  /** Read and count; send nothing and ask the Deployment nothing. */
  dryRun?: boolean;
  /** Only this 1.4 project. */
  project?: string;
}

export interface LegacyImportDeps {
  fetch?: FetchLike;
  now?: () => number;
  mycoHome?: string;
  machineId: string;
  sleep?: (ms: number) => Promise<void>;
  maxPasses?: number;
  /** Requests a minute the import stays under (`paced`); unpaced when absent. */
  pace?: number;
  progress?: (line: string) => void;
}

/** Stops the whole import: the Deployment does not take what this build sends, so nothing more is sent to it. */
class ServerTooOld extends Error {}

/** Stops the whole import: one step waited `IMPORT_WAIT_CAP_MS` for a Deployment that never took it, so nothing after it is tried. */
class WaitedOut extends Error {}

type Probe = { held: Set<string>; withTranscript: Set<string>; tombstoned: Set<string>; vaultSourced: Set<string> };

/** How a step ended: finished, stopped by a class the caller acts on, or failed (`detail` says why). */
type StepEnd = { endedBy?: string; detail?: string };

const emptyProjectReport = (project: LegacyProject, root: string | null): LegacyProjectReport => ({
  projectId: project.projectId,
  root,
  vault: { sessions: project.sessions.length, prompts: project.prompts.length, plans: project.plans.length, spores: project.spores.length, lineage: project.resolutions.length },
  sessions: { distinct: 0, deleted: 0, alreadyHeld: 0, transcriptsShipped: 0, transcriptsHeld: 0, fromVault: 0, resumed: 0 },
  aliases: [], unaliased: [], unmatchedDeletes: [], deletedButHeld: [], stillWriting: [], otherMachines: {},
  prompts: 0, responses: 0, plans: { sent: 0, empty: 0, unsent: 0 }, spores: { saved: 0, duplicate: 0, refused: 0 },
  lineage: { recorded: 0, duplicate: 0, refused: 0, malformed: 0 }, refusals: [], failures: [], malformed: [],
});

/** Every project the sources hold, with the root its newest session names; null where none names one. */
export function legacyProjectRoots(sources: readonly string[]): Array<{ projectId: string; root: string | null; vault: string }> {
  return [...new Set(sources.flatMap(legacyVaultFiles))].flatMap(readLegacyVault).map((p) => ({ projectId: p.projectId, root: rootOf(p), vault: p.vault }));
}

/**
 * How the sources' sessions split between this machine and the machines they
 * record: the sessions a vault import on `machineId` would take, and, by
 * machine id, the ones it leaves for another machine.
 */
export function legacySessionSplit(sources: readonly string[], machineId: string): { thisMachine: number; otherMachines: Record<string, number> } {
  const split = { thisMachine: 0, otherMachines: {} as Record<string, number> };
  for (const project of [...new Set(sources.flatMap(legacyVaultFiles))].flatMap(readLegacyVault)) {
    const grouping = groupLegacySessions(project, new Map(), machineId);
    split.thisMachine += grouping.groups.length;
    for (const [machine, ids] of grouping.otherMachines) split.otherMachines[machine] = (split.otherMachines[machine] ?? 0) + ids.length;
  }
  return split;
}

/** The project root the vault's newest session names, as the filesystem spells it. */
function rootOf(project: LegacyProject): string | null {
  const named = [...project.sessions].reverse().find((s) => s.projectRoot !== null)?.projectRoot ?? null;
  return named === null ? null : canonicalPath(named);
}

const PLAN_STATUS_SET = new Set<string>(PLAN_STATUSES);
const HOOK_ORIGINS: ReadonlySet<string> = new Set<PromptOrigin>(['human', 'system', 'agent_dispatch', 'hook_injected']);

/** A 1.4 prompt origin in the hook rules' words, which the envelope maps onto the wire's; an origin 1.4 never wrote reads as a person's. */
const hookOrigin = (origin: string | null): PromptOrigin | undefined => (origin !== null && HOOK_ORIGINS.has(origin) ? origin as PromptOrigin : undefined);

/** The Deployment to import into, or why there is none. */
function membershipFor(mycoHome: string, serverUrl: string | undefined): DeploymentMembership | string {
  const memberships = listDeploymentMemberships(mycoHome);
  if (serverUrl !== undefined) {
    return memberships.find((m) => deploymentUrl(m.serverUrl) === deploymentUrl(serverUrl)) ?? `this machine holds no membership of ${serverUrl}`;
  }
  if (memberships.length === 1) return memberships[0];
  return memberships.length === 0 ? 'no Deployment membership on this machine' : `this machine belongs to ${memberships.length} Deployments; name one with --server`;
}

/** Why a history event cannot be recorded as 1.4 stored it, or null when it can. */
const malformedResolution = (event: LegacyResolution): string | null =>
  event.action === 'supersede' && event.newSporeId === null ? 'a supersede that names no successor' : null;

interface Prepared extends LegacyGrouping {
  project: LegacyProject;
  root: string | null;
  matched: string[];
  unmatched: string[];
}

/** Read, identify and group every project the sources hold, as `machineId` imports them. */
function prepare(opts: LegacyImportOptions, machineId: string): Prepared[] | string {
  const files = [...new Set(opts.sources.flatMap(legacyVaultFiles))];
  if (files.length === 0) return `no 1.4 vault found in ${opts.sources.join(', ')}`;
  return files.flatMap(readLegacyVault)
    .filter((p) => opts.project === undefined || p.projectId === opts.project)
    .map((project) => {
      const root = rootOf(project);
      const { aliases, matched, unmatched } = aliasByTranscriptTime(project, root);
      return { project, root, matched, unmatched, ...groupLegacySessions(project, aliases, machineId) };
    });
}

/**
 * Import every project the sources hold. Each is sent whole before the next:
 * sessions (facts, transcript, content, plans, end), then spores, then their
 * lineage. A rate limit or an unreachable Deployment is waited out, up to a
 * limit; a step the Deployment keeps failing, or answers with a status no
 * retry changes, is recorded and skipped. What finished is recorded in this
 * machine's ledger, which resumes a later run; what is left out is read from
 * the vault on every run.
 */
export async function runLegacyImport(opts: LegacyImportOptions, deps: LegacyImportDeps): Promise<LegacyImportReport> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? pause;
  const maxPasses = deps.maxPasses ?? IMPORT_MAX_PASSES;
  const progress = deps.progress ?? (() => {});

  const prepared = prepare(opts, deps.machineId);
  if (typeof prepared === 'string') return { serverUrl: null, projects: [], deleted: [], refused: prepared };
  const report: LegacyImportReport = { serverUrl: null, projects: [], deleted: [...new Set(prepared.flatMap((g) => [...g.deleted]))].sort() };

  const startReport = (g: Prepared): LegacyProjectReport => {
    const r = emptyProjectReport(g.project, g.root);
    r.sessions.distinct = g.groups.length;
    r.sessions.deleted = g.deletedSessions.size;
    r.aliases = g.matched;
    r.unaliased = g.unmatched;
    r.unmatchedDeletes = g.unmatchedDeletes;
    r.otherMachines = Object.fromEntries([...g.otherMachines].map(([machine, ids]) => [machine, ids.length]));
    r.lineage.malformed = g.project.resolutions.filter((e) => malformedResolution(e) !== null).length;
    return r;
  };
  if (opts.dryRun === true) {
    report.projects = prepared.map(startReport);
    return report;
  }

  const membership = membershipFor(mycoHome, opts.serverUrl);
  if (typeof membership === 'string') return { ...report, refused: membership };
  const serverUrl = membership.serverUrl;
  report.serverUrl = serverUrl;
  /** Sessions whose transcript this run shipped, so a retried step that finds it held still reports it shipped. */
  const shippedThisRun = new Set<string>();

  const observed = observedFetch(deps.fetch ?? globalThis.fetch);
  const fetchImpl = paced(observed.fetch, deps.pace, sleep, now);
  /** A client on the credential as it is now: a hook may rotate it during a long import. */
  const clientFor = (projectId: string): ServerClient => {
    const fresh = membershipFor(mycoHome, serverUrl);
    const record = typeof fresh === 'string' ? membership : fresh;
    return new ServerClient({ serverUrl: record.serverUrl, token: record.token, projectId }, fetchImpl);
  };

  /** Session phases already appended this run, so a retried drain never appends them twice. */
  const appended = new Set<string>();

  /**
   * Run `step` until it ends on anything but `retry`. A rate limit, a
   * Deployment asking to be retried and a network fault are waited out, for
   * up to `IMPORT_WAIT_CAP_MS` in all, saying so at every wait, and past that
   * stop the whole import (`WaitedOut`); another server error is retried
   * `SERVER_FAULT_RETRIES` times; a status no retry changes fails the step at
   * once. A failed step says why in `detail`.
   */
  const settle = async <T extends StepEnd>(step: () => Promise<T>): Promise<T | StepEnd> => {
    let faults = 0;
    let waited = 0;
    for (let attempt = 1; attempt <= maxPasses; attempt++) {
      const result = await step();
      if (result.endedBy !== 'retry') return result;
      const status = observed.lastStatus();
      const verdict = retryVerdict(status);
      if (verdict === 'fail') return { endedBy: 'failed', detail: `the Deployment answered ${status}` };
      if (verdict === 'fault' && ++faults > SERVER_FAULT_RETRIES) return { endedBy: 'failed', detail: `the Deployment kept failing (${status})` };
      const wait = retryWaitMs(verdict === 'fault' ? faults : attempt);
      if (waited + wait > IMPORT_WAIT_CAP_MS) throw new WaitedOut(`the Deployment ${status === undefined ? 'could not be reached' : `answered ${status}`} for ${Math.round(waited / 60_000)} min; nothing after this was attempted`);
      progress(`the Deployment ${status === undefined ? 'could not be reached' : `answered ${status}`}; trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      waited += wait;
    }
    return { endedBy: 'failed', detail: 'too many tries' };
  };
  const failed = (what: string, end: StepEnd): string => `${what}: ${end.detail ?? 'could not be sent'}`;

  const untouched = (g: Prepared) => ({ sessions: g.groups.length, spores: g.project.spores.length, lineage: g.project.resolutions.length });
  try {
    for (const [index, g] of prepared.entries()) {
      const r = startReport(g);
      report.projects.push(r);
      progress(`${g.project.projectId}: ${g.groups.length} sessions, ${g.project.spores.length} spores, ${g.project.plans.length} plans`);
      r.notAttempted = untouched(g);
      try {
        const ended = await importProject(g, r);
        if (ended !== undefined) r.endedBy = ended;
        else r.notAttempted = undefined;
      } catch (error) {
        if (!(error instanceof WaitedOut)) throw error;
        r.failures.push(error.message);
        r.endedBy = UNREACHABLE;
        for (const rest of prepared.slice(index + 1)) report.projects.push({ ...startReport(rest), endedBy: UNREACHABLE, notAttempted: untouched(rest) });
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof ServerTooOld)) throw error;
    return { ...report, refused: error.message };
  }
  return report;

  /** One project. Answers the class a step could not get past, or undefined when it finished. */
  async function importProject(g: Prepared, r: LegacyProjectReport): Promise<string | undefined> {
    const { project, root } = g;
    const projectId = project.projectId;
    const ledger = new LegacyLedger(mycoHome, serverUrl, projectId);
    const done = ledger.read();
    const spool = new MemberSpool(projectId, { mycoHome });

    // What a person deleted stays out of later transcript imports on this machine as well.
    const newlyDeleted = [...g.deleted].filter((id) => done.sources.get(id) !== 'deleted');
    ledger.append(...newlyDeleted.map((session) => ({ k: 'source' as const, session, from: 'deleted' as const })));

    const deletedIds = [...new Set([...g.deletedSessions.values()].flat())];
    const probe = await settle(() => probeSessions(projectId, [...g.groups.filter((s) => !done.sessions.has(s.sessionId)).map((s) => s.sessionId), ...deletedIds]));
    if (probe.endedBy === 'failed') { r.failures.push(failed('what the Deployment holds of these sessions', probe)); return 'failed'; }
    if (probe.endedBy !== undefined) return probe.endedBy;
    const held = (probe as { probe: Probe }).probe;
    // A deletion is left out only where the Deployment does not hold the session already: a transcript import can get there first.
    for (const ids of g.deletedSessions.values()) {
      const onDeployment = ids.filter((id) => held.held.has(id));
      if (onDeployment.length === 0) continue;
      r.sessions.deleted -= 1;
      r.deletedButHeld.push(...onDeployment);
    }
    r.deletedButHeld.sort();
    const promptsBy = groupBy(project.prompts, (p) => p.sessionId);
    const plansBy = groupBy(project.plans.filter((p) => p.sessionId !== null), (p) => g.idOf.get(p.sessionId as string) ?? (p.sessionId as string));
    /** Sessions whose prompts came from the vault: their prompt ids exist on the Deployment. */
    const vaultContent = new Set([...done.sources].filter(([, from]) => from === 'vault').map(([id]) => id));
    const present = new Set<string>(done.sessions);

    for (const group of g.groups) {
      r.notAttempted!.sessions -= 1;
      if (done.sessions.has(group.sessionId)) { r.sessions.resumed += 1; continue; }
      if (held.tombstoned.has(group.sessionId)) { r.sessions.deleted += 1; continue; }
      const ended = await settle(() => importSession(group));
      if (ended.endedBy === 'failed') { r.failures.push(failed(`session ${group.sessionId}`, ended)); continue; }
      if (ended.endedBy === STILL_WRITING) { r.stillWriting.push(group.sessionId); continue; }
      if (ended.endedBy === 'deleted' || ended.endedBy === REFUSED) continue;
      if (ended.endedBy !== undefined) return ended.endedBy;
      present.add(group.sessionId);
      ledger.append({ k: 'session', session: group.sessionId });
    }
    r.plans.unsent = project.plans.length - r.plans.sent - r.plans.empty;

    for (const spore of project.spores) {
      r.notAttempted!.spores -= 1;
      if (done.spores.has(spore.id)) { r.spores.duplicate += 1; continue; }
      const sessionId = spore.sessionId === null ? null : g.idOf.get(spore.sessionId) ?? null;
      const onDeployment = sessionId !== null && present.has(sessionId) ? sessionId : null;
      const promptId = onDeployment !== null && vaultContent.has(onDeployment) && spore.promptId !== null ? legacyPromptId(projectId, spore.promptId) : null;
      const outcome = await settle(async () => classified(await clientFor(projectId).postPersisted(SPORES_SAVE_PATH, {
        id: spore.id, agentId: spore.agentId, observationType: spore.observationType, status: spore.status,
        content: spore.content, context: spore.context, sessionId: onDeployment, promptId,
        importance: spore.importance ?? undefined, filePath: spore.filePath, tags: spore.tags, contentHash: spore.contentHash,
        properties: spore.properties, createdAt: spore.createdAt ?? undefined,
      }, unboundedBudget())));
      if (outcome.endedBy === 'failed') { r.failures.push(failed(`spore ${spore.id}`, outcome)); continue; }
      if (outcome.endedBy !== undefined) return outcome.endedBy;
      const answer = outcome as Classified;
      if (answer.refusal !== undefined) { r.spores.refused += 1; r.refusals.push(`spore ${spore.id}: ${answer.refusal}`); continue; }
      if (answer.duplicate) r.spores.duplicate += 1; else r.spores.saved += 1;
      ledger.append({ k: 'spore', id: spore.id });
    }

    const finalStatus = new Map(project.spores.map((s) => [s.id, s.status]));
    for (const event of project.resolutions) {
      r.notAttempted!.lineage -= 1;
      const malformed = malformedResolution(event);
      if (malformed !== null) { r.malformed.push(`history ${event.id}: ${malformed}`); continue; }
      if (done.lineage.has(event.id)) { r.lineage.duplicate += 1; continue; }
      const status = finalStatus.get(event.sporeId);
      if (status === undefined) { r.lineage.refused += 1; r.refusals.push(`history ${event.id}: its spore ${event.sporeId} is not in the vault`); continue; }
      const sessionId = event.sessionId === null ? null : g.idOf.get(event.sessionId) ?? null;
      const outcome = await settle(async () => classified(await clientFor(projectId).postPersisted(SPORES_RESOLVE_PATH, {
        eventId: event.id, agentId: event.agentId, sporeId: event.sporeId, action: event.action, status,
        newSporeId: event.newSporeId, reason: event.reason, sessionId: sessionId !== null && present.has(sessionId) ? sessionId : null,
        channel: 'import', createdAt: event.createdAt ?? undefined,
      }, unboundedBudget())));
      if (outcome.endedBy === 'failed') { r.failures.push(failed(`history ${event.id}`, outcome)); continue; }
      if (outcome.endedBy !== undefined) return outcome.endedBy;
      const answer = outcome as Classified;
      if (answer.refusal !== undefined) { r.lineage.refused += 1; r.refusals.push(`history ${event.id}: ${answer.refusal}`); continue; }
      if (answer.body?.resolved === false) { r.lineage.refused += 1; r.refusals.push(`history ${event.id}: its spore ${event.sporeId} is not on the Deployment`); continue; }
      if (answer.duplicate) r.lineage.duplicate += 1; else r.lineage.recorded += 1;
      ledger.append({ k: 'lineage', id: event.id });
    }
    return undefined;

    /** A drain that ended on refusals reports them and ends the session's step as refused; any other end is the step's. */
    function refusedOr(end: DrainEnd, sessionId: string): StepEnd {
      if (end.refused.length === 0) return { endedBy: end.endedBy };
      r.refusals.push(...end.refused.map((e) => `session ${sessionId}: ${e.kind} refused (${e.code}: ${e.reason})`));
      return { endedBy: REFUSED };
    }

    /**
     * One session. Its content source is decided before anything is sent and
     * recorded; facts, transcript, content, plans and end follow, sent and
     * drained. Its counts reach the report once, when every event reached the
     * Deployment.
     */
    async function importSession(group: SessionGroup): Promise<StepEnd> {
      const s = group.winner;
      const client = clientFor(projectId);
      const located = locateTranscript(group.agent, group.sessionId, s.transcriptPath);
      const agent = located?.agent ?? group.agent;
      const candidate = located === null ? null : transcriptCandidate(agent, group.sessionId, located.file, root ?? '', deps.machineId, now());
      const planned = candidate === null || candidate === 'active' ? null : await planTranscript(candidate, client);
      if (planned !== null && 'endedBy' in planned) return planned;
      const plan = planned as PlanDecision | null;

      // The Deployment's record of a vault-sourced session decides first; this
      // machine's ledger only saves asking again.
      let source: ContentSource | undefined = held.vaultSourced.has(group.sessionId) || plan?.decision === 'vault_sourced' ? 'vault' : ledger.read().sources.get(group.sessionId);
      // A transcript still being written decides nothing and sends nothing
      // until it settles, unless the Deployment already holds a transcript
      // of it: a later run brings it from that transcript.
      if (candidate === 'active' && source === undefined && !held.withTranscript.has(group.sessionId)) return { endedBy: STILL_WRITING };
      if (source === undefined) {
        // A transcript still being written is the session's source too: the hook
        // capturing it, or a later transcript import, brings it.
        source = plan?.decision === 'tombstoned' ? 'deleted'
          : plan !== null && plan.decision !== 'unoffered' ? 'transcript'
          : held.withTranscript.has(group.sessionId) ? 'transcript'
          : 'vault';
        ledger.append({ k: 'source', session: group.sessionId, from: source });
      }
      if (source === 'deleted') { r.sessions.deleted += 1; return { endedBy: 'deleted' }; }

      const at = (instant: number | null) => () => instant ?? s.startedAt ?? s.endedAt ?? 0;
      const ctx = (instant: number | null): EnvelopeContext => ({
        agent, sessionId: group.sessionId, stage: spool.stagerFor(group.sessionId), now: at(instant), channel: 'import', producer: LEGACY_PRODUCER,
      });
      const withId = (out: OutboundEvent, ...key: string[]): OutboundEvent => ({ ...out, envelope: { ...out.envelope, eventId: legacyId(projectId, ...key) } });
      const alreadyHeld = held.held.has(group.sessionId);

      // A session the Deployment already holds keeps the facts it was captured with.
      const facts = alreadyHeld ? [] : [withId(sessionStartEvent(ctx(s.startedAt), {
        startedAt: s.startedAt ?? undefined,
        branch: s.branch ?? undefined,
        originPath: root ?? s.projectRoot ?? undefined,
        parentSessionId: s.parentSessionId === null ? undefined : g.idOf.get(s.parentSessionId),
        parentReason: s.parentReason ?? undefined,
      }), 'session.start', group.sessionId)];
      appendOnce(spool, group.sessionId, 'facts', facts);
      const drainedFacts = await drain(spool, group.sessionId, client);
      if (drainedFacts !== undefined) return refusedOr(drainedFacts, group.sessionId);

      let transcript: 'shipped' | 'held' | null = source === 'transcript' ? 'held' : null;
      if (plan !== null && plan.decision === 'take' && candidate !== null && candidate !== 'active') {
        const shipped = await shipSession(candidate, plan.fromOffset, client, spool, deps.machineId, now, { facts: false });
        if (shipped === 'done') { shippedThisRun.add(group.sessionId); transcript = 'shipped'; }
        else if (shipped !== 'absent') return { endedBy: shipped };
      }
      if (transcript === 'held' && shippedThisRun.has(group.sessionId)) transcript = 'shipped';

      const fromVault = source === 'vault';
      if (fromVault) vaultContent.add(group.sessionId);
      const events: OutboundEvent[] = [];
      if (fromVault) {
        for (const p of promptsBy.get(group.promptsFrom) ?? []) {
          const promptId = legacyPromptId(projectId, p.id);
          if (p.text !== null) {
            events.push(withId(promptEvent(ctx(p.startedAt), {
              promptId, text: p.text, origin: hookOrigin(p.origin),
              parentPromptId: p.parentId === null ? undefined : legacyPromptId(projectId, p.parentId),
              threadId: p.threadId ?? undefined, threadLabel: p.threadLabel ?? undefined,
            }), 'prompt', p.id));
          }
          if (p.response !== null) {
            events.push(withId(responseEvent(ctx(p.endedAt ?? p.startedAt), {
              text: p.response, promptId: p.text === null ? undefined : promptId, responseId: legacyId(projectId, 'response-id', p.id),
            }), 'response', p.id));
          }
        }
      }
      let emptyPlans = 0;
      for (const plan of plansBy.get(group.sessionId) ?? []) {
        if (plan.content === null) { emptyPlans += 1; continue; }
        const { planKey, originPath } = legacyPlanKey(projectId, root, plan);
        events.push(withId(planEvent(ctx(plan.updatedAt ?? plan.createdAt), {
          planKey, content: plan.content, title: plan.title ?? undefined, originPath,
          status: plan.status !== null && PLAN_STATUS_SET.has(plan.status) ? plan.status as PlanStatus : undefined,
          tags: plan.tags === null ? undefined : plan.tags.split(',').map((t) => t.trim()).filter((t) => t.length > 0),
          promptId: plan.promptId !== null && fromVault ? legacyPromptId(projectId, plan.promptId) : undefined,
        }), 'plan', plan.id));
      }
      // A held session's end is live capture's; the title travels on its own, the same event whether or not the end was sent.
      if (!alreadyHeld) {
        events.push(withId(sessionEndEvent(ctx(s.endedAt), { endedAt: s.endedAt ?? s.startedAt ?? undefined }), 'session.end', group.sessionId));
      }
      if (group.title !== null) {
        events.push(withId(sessionTitleEvent(ctx(s.endedAt), { title: group.title, summary: group.summary ?? undefined }), 'session.title', group.sessionId));
      }
      appendOnce(spool, group.sessionId, 'rows', events);
      const drainedRows = await drain(spool, group.sessionId, client);
      if (drainedRows !== undefined) return refusedOr(drainedRows, group.sessionId);

      const kinds = (kind: string) => events.filter((e) => e.envelope.kind === kind).length;
      if (alreadyHeld) r.sessions.alreadyHeld += 1;
      if (transcript === 'shipped') r.sessions.transcriptsShipped += 1;
      if (transcript === 'held') r.sessions.transcriptsHeld += 1;
      if (fromVault) r.sessions.fromVault += 1;
      r.prompts += kinds('prompt');
      r.responses += kinds('response');
      r.plans.sent += kinds('plan');
      r.plans.empty += emptyPlans;
      return {};
    }
  }

  /** Plan one transcript: where to ship it from, or why it is not shipped. */
  async function planTranscript(candidate: Candidate, client: ServerClient): Promise<PlanDecision | StepEnd> {
    const answer = await client.importPlan({
      windowDays: LEGACY_WINDOW_DAYS, maxPerAgent: LEGACY_MAX_PER_AGENT,
      candidates: [{ sessionId: candidate.sessionId, transcriptId: candidate.transcriptId, agent: candidate.agent, sizeBytes: candidate.sizeBytes, modifiedAt: candidate.modifiedAt, headHash: candidate.headHash }],
    }, unboundedBudget());
    if (answer.class !== 'acked') return { endedBy: answer.class };
    const decision = (Array.isArray(answer.body.candidates) ? answer.body.candidates : [])[0] as Record<string, unknown> | undefined;
    if (decision === undefined) return { decision: 'unoffered' };
    if (decision.take === 'from') return { decision: 'take', fromOffset: Number(decision.fromOffset ?? 0) };
    if (decision.reason === 'tombstoned') return { decision: 'tombstoned' };
    if (decision.reason === 'vault_sourced') return { decision: 'vault_sourced' };
    return { decision: decision.reason === 'window' || decision.reason === 'cap' ? 'unoffered' : 'held' };
  }

  /** What the Deployment holds of these sessions, asked in runs under the route's ceiling. */
  async function probeSessions(projectId: string, sessionIds: readonly string[]): Promise<{ probe: Probe; endedBy?: string }> {
    const probe: Probe = { held: new Set(), withTranscript: new Set(), tombstoned: new Set(), vaultSourced: new Set() };
    const client = clientFor(projectId);
    for (let i = 0; i < Math.max(sessionIds.length, 1); i += PROBE_CHUNK) {
      const run = sessionIds.slice(i, i + PROBE_CHUNK);
      const answer = await client.importPlan({ candidates: [], sessions: run.length === 0 ? undefined : run }, unboundedBudget());
      if (answer.class !== 'acked') return { probe, endedBy: answer.class };
      if (run.length === 0) break;
      const sessions = answer.body.sessions as { held?: unknown; withTranscript?: unknown; tombstoned?: unknown; vaultSourced?: unknown } | undefined;
      if (sessions === undefined) throw new ServerTooOld(`${report.serverUrl} does not answer what it holds of a session; update the Deployment before importing a 1.4 vault`);
      for (const [key, into] of [['held', probe.held], ['withTranscript', probe.withTranscript], ['tombstoned', probe.tombstoned], ['vaultSourced', probe.vaultSourced]] as const) {
        const list = sessions[key];
        if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') into.add(id);
      }
    }
    return { probe };
  }

  /** Append a session's events once per run, however many passes its drain takes. */
  function appendOnce(spool: MemberSpool, sessionId: string, phase: string, events: readonly OutboundEvent[]): void {
    const key = `${spool.projectId}\0${sessionId}\0${phase}`;
    if (appended.has(key)) return;
    appended.add(key);
    if (events.length > 0) spool.appendAndRecord(sessionId, events);
  }

  /** Drain a session's spooled events. Undefined when they all reached the Deployment; else the class that stopped them. */
  /**
   * Drain a session's spooled events. Undefined when every one reached the
   * Deployment; else how the drain ended and every refusal it met — the ones
   * the spool dropped for good as much as the one it holds — none of which may
   * pass for a delivered event.
   */
  async function drain(spool: MemberSpool, sessionId: string, client: ServerClient): Promise<DrainEnd | undefined> {
    const seen = spool.readRefused().entries.length;
    const drained = await spool.drainSession(sessionId, client, unboundedBudget(), { now, force: true });
    const log = spool.readRefused().entries;
    const met = log.slice(seen).filter((e) => e.sessionId === sessionId);
    // A refusal the spool still holds is logged once, the first time it is met.
    const held = drained.endedBy === 'refused' && met.length === 0 ? log.filter((e) => e.sessionId === sessionId).slice(-1) : [];
    const refused = [...met, ...held];
    const version = refused.find((e) => REFUSAL_SUBJECT[e.code] === 'server-version');
    if (version !== undefined) {
      throw new ServerTooOld(`${report.serverUrl} refused ${version.kind} (${version.code}: ${version.reason}); update the Deployment before importing a 1.4 vault`);
    }
    if (drained.endedBy === 'drained' && refused.length === 0) return undefined;
    return { endedBy: drained.endedBy === 'drained' ? undefined : drained.endedBy, refused };
  }
}

/** What the Deployment answers for one transcript: ship it from a byte, or why not. */
type PlanDecision = { decision: 'take'; fromOffset: number } | { decision: 'held' | 'tombstoned' | 'vault_sourced' | 'unoffered' };

/** How a drain that did not simply deliver everything ended, with the refusals it met. */
type DrainEnd = { endedBy: string | undefined; refused: RefusedEntry[] };

/** The end of a session step that met refusals: reported, and the session is not recorded as done. */
const REFUSED = 'refused-events';
/** A session step that ended before anything was sent: its transcript is still being written. */
const STILL_WRITING = 'still-writing';
/** A project the import stopped at, or never reached, once a step waited out its limit. */
export const UNREACHABLE = 'unreachable';

type Classified = { endedBy?: string; refusal?: string; duplicate?: boolean; body?: Record<string, unknown> };

/** An answer to a persisted route: stopped (retryable or not), refused with a reason, or recorded. */
function classified(outcome: Outcome): Classified {
  if (outcome.class === 'acked') return { duplicate: outcome.duplicate === true || outcome.body.duplicate === true, body: outcome.body };
  if (outcome.class === 'refused') return { refusal: `${outcome.code}: ${outcome.reason}` };
  return { endedBy: outcome.class };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) out.set(k, [item]); else list.push(item);
  }
  return out;
}
