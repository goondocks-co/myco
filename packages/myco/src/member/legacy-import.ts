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
 * **One content source per session.** Its transcript, where a file is on disk
 * and ships or the Deployment already holds one; the vault's prompts and
 * responses only where neither is true. A session the Deployment already
 * holds keeps the facts live capture recorded: no start is sent for it.
 *
 * **Every write is idempotent.** Event ids derive from the vault row, the
 * producer is fixed, and every instant is the vault's, so a second run sends
 * byte-identical envelopes the Deployment answers as duplicates. Spores and
 * lineage keep their 1.4 ids.
 *
 * The vault is opened read-only and is never written.
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { manifestTranscriptDiscovery, findTranscriptFor, sessionIdFromStoredId, sessionIdFromTranscriptPath } from '../symbionts/transcript-discovery.js';
import { canonicalPath } from '../symbionts/transcript-attribution.js';
import { resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from './budget.js';
import {
  deriveId, planEvent, planKeyForPath, promptEvent, responseEvent, sessionEndEvent, sessionStartEvent,
  type EnvelopeContext, type OutboundEvent,
} from './envelope.js';
import { pause, retryWaitMs, IMPORT_MAX_PASSES, shipSession, transcriptCandidate, type Candidate } from './import.js';
import { normalizePlanPath } from './plan-files.js';
import { deploymentUrl, listDeploymentMemberships, type DeploymentMembership } from './registry.js';
import { MemberSpool } from './spool.js';
import { ServerClient, type FetchLike, type Outcome } from './transport.js';
import { REFUSAL_SUBJECT } from './constants.js';
import { PLAN_STATUSES, type PlanStatus } from '@goondocks/myco-shared/member-protocol';
import type { PromptOrigin } from '@goondocks/myco-shared/capture-rules';

/** The producer every envelope this import sends names. Fixed, so a rebuilt binary re-sends envelopes the Deployment reads as the ones it holds. */
export const LEGACY_PRODUCER = { adapter: 'legacy-import', version: '1' } as const;
/** The furthest back a plan for a vault session's transcript reaches, and the most per agent: the Deployment's ceilings, since the vault already bounds what is offered. */
export const LEGACY_WINDOW_DAYS = 3650;
export const LEGACY_MAX_PER_AGENT = 1000;
/** Session ids one probe of the Deployment names; the plan route's candidate ceiling. */
const PROBE_CHUNK = 1000;
/** A 1.4 instant below this is seconds; at or above it, milliseconds. */
const MS_FLOOR = 100_000_000_000;
const SPORES_SAVE_PATH = '/spores/save';
const SPORES_RESOLVE_PATH = '/spores/resolve';
const VAULT_FILE = 'myco.db';
const GROVES_DIR = 'groves';

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
  /** Session ids 1.4 deleted. */
  deleted: Set<string>;
}

/** A 1.4 instant in milliseconds, whichever unit the row stored it in. */
export const legacyMs = (value: number | null | undefined): number | null =>
  typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ? null : value < MS_FLOOR ? Math.trunc(value * 1000) : Math.trunc(value);

/** The vault files a source names: a `myco.db`, a directory holding one, or a 1.4 home whose `groves/*` hold them. Empty files are no vault. */
export function legacyVaultFiles(source: string): string[] {
  const nonEmpty = (file: string): boolean => { try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; } };
  if (nonEmpty(source)) return [path.resolve(source)];
  const direct = path.join(source, VAULT_FILE);
  if (nonEmpty(direct)) return [path.resolve(direct)];
  const groves = path.join(source, GROVES_DIR);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(groves, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(groves, e.name, VAULT_FILE))
    .filter(nonEmpty)
    .sort();
}

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
        held = { projectId: key, vault: file, sessions: [], prompts: [], plans: [], spores: [], resolutions: [], deleted: new Set() };
        projects.set(key, held);
      }
      return held;
    };

    for (const r of rows(`SELECT * FROM sessions WHERE project_id IS NOT NULL ORDER BY started_at, id`)) {
      project(r.project_id).sessions.push({
        id: idOf(r.id), agent: text(r.agent) ?? 'unknown', projectRoot: text(r.project_root), branch: text(r.branch),
        startedAt: legacyMs(num(r.started_at)), endedAt: legacyMs(num(r.ended_at)), title: text(r.title), summary: text(r.summary),
        transcriptPath: text(r.transcript_path), parentSessionId: text(r.parent_session_id), parentReason: text(r.parent_session_reason),
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
      for (const r of rows(`SELECT session_id, project_id FROM session_tombstones WHERE project_id IS NOT NULL`)) {
        project(r.project_id).deleted.add(idOf(r.session_id));
      }
    }
    return [...projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
  } finally {
    db.close();
  }
}

/**
 * The id the harness's transcript layout names for a vault session: the one
 * its recorded transcript path yields, else the one the layout's id shape
 * finds in the stored id, else the stored id itself.
 */
export function legacySessionId(agent: string, storedId: string, transcriptPath: string | null): string {
  const discovery = manifestTranscriptDiscovery(agent);
  const byPath = transcriptPath === null ? null : sessionIdFromTranscriptPath(discovery, transcriptPath);
  return byPath ?? sessionIdFromStoredId(discovery, storedId) ?? storedId;
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

/** A vault session with every row that names the same harness session: the later-started row is the one whose facts and content stand. */
interface SessionGroup {
  sessionId: string;
  winner: LegacySession;
  storedIds: string[];
}

/** Vault sessions grouped by the session id each takes, deleted ones left out. */
export function groupLegacySessions(project: LegacyProject): { groups: SessionGroup[]; idOf: Map<string, string>; deleted: Set<string> } {
  const idOf = new Map<string, string>();
  const byId = new Map<string, SessionGroup>();
  const deleted = new Set<string>();
  for (const s of project.sessions) {
    const sessionId = legacySessionId(s.agent, s.id, s.transcriptPath);
    idOf.set(s.id, sessionId);
    if (project.deleted.has(s.id)) { deleted.add(sessionId); continue; }
    const held = byId.get(sessionId);
    if (held === undefined) { byId.set(sessionId, { sessionId, winner: s, storedIds: [s.id] }); continue; }
    held.storedIds.push(s.id);
    if ((s.startedAt ?? 0) > (held.winner.startedAt ?? 0)) held.winner = s;
  }
  for (const id of project.deleted) if (!idOf.has(id)) deleted.add(id);
  for (const id of deleted) byId.delete(id);
  const groups = [...byId.values()].sort((a, b) => (a.winner.startedAt ?? 0) - (b.winner.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
  return { groups, idOf, deleted };
}

export interface LegacyProjectReport {
  projectId: string;
  root: string | null;
  vault: { sessions: number; prompts: number; plans: number; spores: number; lineage: number };
  sessions: {
    /** Distinct sessions after rows naming one session are merged. */
    distinct: number;
    /** Deleted in 1.4, or on the Deployment: not sent. */
    deleted: number;
    /** Already on the Deployment: their facts are left as captured. */
    alreadyHeld: number;
    transcriptsShipped: number;
    transcriptsHeld: number;
    /** Sessions whose prompts and responses came from the vault. */
    fromVault: number;
  };
  prompts: number;
  responses: number;
  /** Plans sent; plans with no content; plans whose session is deleted or not in the vault. */
  plans: { sent: number; empty: number; unsent: number };
  spores: { saved: number; duplicate: number; refused: number };
  lineage: { recorded: number; refused: number };
  /** Ids the Deployment refused, with its reason. */
  refusals: string[];
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
  progress?: (line: string) => void;
}

/** Stops the whole import: the Deployment does not take what this build sends, so nothing more is sent to it. */
class ServerTooOld extends Error {}

type Probe = { held: Set<string>; withTranscript: Set<string>; tombstoned: Set<string> };

const emptyProjectReport = (project: LegacyProject, root: string | null): LegacyProjectReport => ({
  projectId: project.projectId,
  root,
  vault: { sessions: project.sessions.length, prompts: project.prompts.length, plans: project.plans.length, spores: project.spores.length, lineage: project.resolutions.length },
  sessions: { distinct: 0, deleted: 0, alreadyHeld: 0, transcriptsShipped: 0, transcriptsHeld: 0, fromVault: 0 },
  prompts: 0, responses: 0, plans: { sent: 0, empty: 0, unsent: 0 }, spores: { saved: 0, duplicate: 0, refused: 0 }, lineage: { recorded: 0, refused: 0 }, refusals: [],
});

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

/**
 * Import every project the sources hold. Each is sent whole before the next:
 * sessions (facts, transcript, content, plans, end), then spores, then their
 * lineage. A pass stopped by a rate limit or a transport fault waits and
 * resumes; nothing it already sent is sent differently.
 */
export async function runLegacyImport(opts: LegacyImportOptions, deps: LegacyImportDeps): Promise<LegacyImportReport> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? pause;
  const maxPasses = deps.maxPasses ?? IMPORT_MAX_PASSES;
  const progress = deps.progress ?? (() => {});

  const files = [...new Set(opts.sources.flatMap(legacyVaultFiles))];
  if (files.length === 0) return { serverUrl: null, projects: [], deleted: [], refused: `no 1.4 vault found in ${opts.sources.join(', ')}` };
  const projects = files.flatMap(readLegacyVault).filter((p) => opts.project === undefined || p.projectId === opts.project);

  const deleted = new Set<string>();
  const report: LegacyImportReport = { serverUrl: null, projects: [], deleted: [] };
  const grouped = projects.map((project) => ({ project, root: rootOf(project), ...groupLegacySessions(project) }));
  for (const g of grouped) for (const id of g.deleted) deleted.add(id);
  report.deleted = [...deleted].sort();

  if (opts.dryRun === true) {
    for (const g of grouped) {
      const r = emptyProjectReport(g.project, g.root);
      r.sessions.distinct = g.groups.length;
      r.sessions.deleted = g.deleted.size;
      report.projects.push(r);
    }
    return report;
  }

  const membership = membershipFor(mycoHome, opts.serverUrl);
  if (typeof membership === 'string') return { ...report, refused: membership };
  report.serverUrl = membership.serverUrl;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  /** A client on the credential as it is now: a hook may rotate it during a long import. */
  const clientFor = (projectId: string): ServerClient => {
    const fresh = membershipFor(mycoHome, membership.serverUrl);
    const record = typeof fresh === 'string' ? membership : fresh;
    return new ServerClient({ serverUrl: record.serverUrl, token: record.token, projectId }, fetchImpl);
  };

  /** Session phases already appended this run, so a retried drain never appends them twice. */
  const appended = new Set<string>();

  /** Run `step` until it ends on anything but `retry`, waiting between tries. */
  const settle = async <T extends { endedBy?: string }>(step: () => Promise<T>): Promise<T> => {
    let result = await step();
    for (let attempt = 1; attempt < maxPasses && result.endedBy === 'retry'; attempt++) {
      await sleep(retryWaitMs(attempt));
      result = await step();
    }
    return result;
  };

  try {
    for (const g of grouped) {
      const r = emptyProjectReport(g.project, g.root);
      report.projects.push(r);
      r.sessions.distinct = g.groups.length;
      r.sessions.deleted = g.deleted.size;
      progress(`${g.project.projectId}: ${g.groups.length} sessions, ${g.project.spores.length} spores, ${g.project.plans.length} plans`);
      const ended = await importProject(g, r);
      if (ended !== undefined) r.endedBy = ended;
    }
  } catch (error) {
    if (!(error instanceof ServerTooOld)) throw error;
    return { ...report, refused: error.message };
  }
  return report;

  /** One project. Answers the class a pass could not get past, or undefined when it finished. */
  async function importProject(
    g: { project: LegacyProject; root: string | null; groups: SessionGroup[]; idOf: Map<string, string>; deleted: Set<string> },
    r: LegacyProjectReport,
  ): Promise<string | undefined> {
    const { project, root } = g;
    const projectId = project.projectId;
    const probe = await settle(() => probeSessions(projectId, g.groups.map((s) => s.sessionId)));
    if (probe.endedBy !== undefined) return probe.endedBy;
    const held = probe.probe;
    const spool = new MemberSpool(projectId, { mycoHome });
    const promptsBy = groupBy(project.prompts, (p) => p.sessionId);
    const plansBy = groupBy(project.plans.filter((p) => p.sessionId !== null), (p) => g.idOf.get(p.sessionId as string) ?? (p.sessionId as string));
    /** Sessions whose prompts came from the vault: their prompt ids exist on the Deployment. */
    const vaultContent = new Set<string>();
    /** Sessions whose transcript this run shipped, so a retried pass that finds it held still reports it shipped. */
    const shippedThisRun = new Set<string>();
    const present = new Set<string>();

    for (const group of g.groups) {
      if (held.tombstoned.has(group.sessionId)) { r.sessions.deleted += 1; continue; }
      const ended = await settle(() => importSession(group));
      if (ended.endedBy !== undefined) return ended.endedBy;
      present.add(group.sessionId);
    }
    r.plans.unsent = project.plans.length - r.plans.sent - r.plans.empty;

    for (const spore of project.spores) {
      const sessionId = spore.sessionId === null ? null : g.idOf.get(spore.sessionId) ?? null;
      const onDeployment = sessionId !== null && present.has(sessionId) ? sessionId : null;
      const promptId = onDeployment !== null && vaultContent.has(onDeployment) && spore.promptId !== null ? legacyPromptId(projectId, spore.promptId) : null;
      const outcome = await settle(async () => classified(await clientFor(projectId).postPersisted(SPORES_SAVE_PATH, {
        id: spore.id, agentId: spore.agentId, observationType: spore.observationType, status: spore.status,
        content: spore.content, context: spore.context, sessionId: onDeployment, promptId,
        importance: spore.importance ?? undefined, filePath: spore.filePath, tags: spore.tags, contentHash: spore.contentHash,
        properties: spore.properties, createdAt: spore.createdAt ?? undefined,
      }, unboundedBudget())));
      if (outcome.endedBy !== undefined) return outcome.endedBy;
      if (outcome.refusal !== undefined) { r.spores.refused += 1; r.refusals.push(`spore ${spore.id}: ${outcome.refusal}`); continue; }
      if (outcome.duplicate) r.spores.duplicate += 1; else r.spores.saved += 1;
    }

    const finalStatus = new Map(project.spores.map((s) => [s.id, s.status]));
    for (const event of project.resolutions) {
      const status = finalStatus.get(event.sporeId);
      if (status === undefined) { r.lineage.refused += 1; r.refusals.push(`lineage ${event.id}: its spore ${event.sporeId} is not in the vault`); continue; }
      const sessionId = event.sessionId === null ? null : g.idOf.get(event.sessionId) ?? null;
      const outcome = await settle(async () => classified(await clientFor(projectId).postPersisted(SPORES_RESOLVE_PATH, {
        eventId: event.id, agentId: event.agentId, sporeId: event.sporeId, action: event.action, status,
        newSporeId: event.newSporeId, reason: event.reason, sessionId: sessionId !== null && present.has(sessionId) ? sessionId : null,
      }, unboundedBudget())));
      if (outcome.endedBy !== undefined) return outcome.endedBy;
      if (outcome.refusal !== undefined) { r.lineage.refused += 1; r.refusals.push(`lineage ${event.id}: ${outcome.refusal}`); continue; }
      if (outcome.body?.resolved === false) { r.lineage.refused += 1; r.refusals.push(`lineage ${event.id}: its spore ${event.sporeId} is not on the Deployment`); continue; }
      r.lineage.recorded += 1;
    }
    return undefined;

    /**
     * One session: facts, transcript, content, plans and end, sent and drained.
     * Its counts reach the report once, when every event reached the
     * Deployment; a pass a retry repeats counts nothing twice.
     */
    async function importSession(group: SessionGroup): Promise<{ endedBy?: string }> {
      const s = group.winner;
      const client = clientFor(projectId);
      const at = (instant: number | null) => () => instant ?? s.startedAt ?? s.endedAt ?? 0;
      const ctx = (instant: number | null): EnvelopeContext => ({
        agent: s.agent, sessionId: group.sessionId, stage: spool.stagerFor(group.sessionId), now: at(instant), channel: 'import', producer: LEGACY_PRODUCER,
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
      if (drainedFacts !== undefined) return { endedBy: drainedFacts };

      // The transcript, where one is on disk: shipped under this Project whatever directory it records.
      let transcript: 'shipped' | 'held' | null = held.withTranscript.has(group.sessionId) ? 'held' : null;
      const file = transcriptFileFor(s, group.sessionId);
      const candidate = file === null ? null : transcriptCandidate(s.agent, group.sessionId, file, root ?? '', deps.machineId, now());
      if (candidate !== null && candidate !== 'active') {
        const shipped = await shipTranscript(candidate, client, spool);
        if (shipped === 'tombstoned') { r.sessions.deleted += 1; return {}; }
        if (shipped === 'shipped') { shippedThisRun.add(group.sessionId); transcript = 'shipped'; }
        else if (shipped === 'held') transcript = shippedThisRun.has(group.sessionId) ? 'shipped' : 'held';
        else if (shipped !== 'absent') return { endedBy: shipped };
      }

      // Content comes from the vault only where no transcript holds it.
      const fromVault = transcript === null;
      if (fromVault) vaultContent.add(group.sessionId);
      const events: OutboundEvent[] = [];
      if (fromVault) {
        for (const p of promptsBy.get(s.id) ?? []) {
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
      events.push(withId(sessionEndEvent(ctx(s.endedAt), {
        endedAt: s.endedAt ?? s.startedAt ?? undefined, title: s.title ?? undefined, summary: s.summary ?? undefined,
      }), 'session.end', group.sessionId));
      appendOnce(spool, group.sessionId, 'rows', events);
      const drainedRows = await drain(spool, group.sessionId, client);
      if (drainedRows !== undefined) return { endedBy: drainedRows };

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

    /** The transcript on disk for a vault session: the path it recorded when that names this session, else where the layout puts it. */
    function transcriptFileFor(s: LegacySession, sessionId: string): string | null {
      const discovery = manifestTranscriptDiscovery(s.agent);
      if (s.transcriptPath !== null && fs.existsSync(s.transcriptPath) && sessionIdFromTranscriptPath(discovery, s.transcriptPath) === sessionId) return s.transcriptPath;
      return discovery === undefined ? null : findTranscriptFor(s.agent, sessionId);
    }

    /** Plan one transcript and ship it from the byte the Deployment names. */
    async function shipTranscript(candidate: Candidate, client: ServerClient, spool: MemberSpool): Promise<'shipped' | 'held' | 'tombstoned' | 'absent' | string> {
      const answer = await client.importPlan({
        windowDays: LEGACY_WINDOW_DAYS, maxPerAgent: LEGACY_MAX_PER_AGENT,
        candidates: [{ sessionId: candidate.sessionId, transcriptId: candidate.transcriptId, agent: candidate.agent, sizeBytes: candidate.sizeBytes, modifiedAt: candidate.modifiedAt, headHash: candidate.headHash }],
      }, unboundedBudget());
      if (answer.class !== 'acked') return answer.class;
      const decision = (Array.isArray(answer.body.candidates) ? answer.body.candidates : [])[0] as Record<string, unknown> | undefined;
      if (decision === undefined) return 'absent';
      if (decision.take !== 'from') {
        if (decision.reason === 'tombstoned') return 'tombstoned';
        return decision.reason === 'window' || decision.reason === 'cap' ? 'absent' : 'held';
      }
      const shipped = await shipSession(candidate, Number(decision.fromOffset ?? 0), client, spool, deps.machineId, now, { facts: false });
      if (shipped === 'done') return 'shipped';
      return shipped;
    }
  }

  /** What the Deployment holds of these sessions, asked in runs under the route's ceiling. */
  async function probeSessions(projectId: string, sessionIds: readonly string[]): Promise<{ probe: Probe; endedBy?: string }> {
    const probe: Probe = { held: new Set(), withTranscript: new Set(), tombstoned: new Set() };
    const client = clientFor(projectId);
    for (let i = 0; i < Math.max(sessionIds.length, 1); i += PROBE_CHUNK) {
      const run = sessionIds.slice(i, i + PROBE_CHUNK);
      const answer = await client.importPlan({ candidates: [], sessions: run.length === 0 ? undefined : run }, unboundedBudget());
      if (answer.class !== 'acked') return { probe, endedBy: answer.class };
      if (run.length === 0) break;
      const sessions = answer.body.sessions as { held?: unknown; withTranscript?: unknown; tombstoned?: unknown } | undefined;
      if (sessions === undefined) throw new ServerTooOld(`${membershipUrl()} does not answer what it holds of a session; update the Deployment before importing a 1.4 vault`);
      for (const [key, into] of [['held', probe.held], ['withTranscript', probe.withTranscript], ['tombstoned', probe.tombstoned]] as const) {
        const list = sessions[key];
        if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') into.add(id);
      }
    }
    return { probe };
  }

  function membershipUrl(): string {
    return report.serverUrl ?? 'the Deployment';
  }

  /** Append a session's events once per run, however many passes its drain takes. */
  function appendOnce(spool: MemberSpool, sessionId: string, phase: string, events: readonly OutboundEvent[]): void {
    const key = `${spool.projectId}\0${sessionId}\0${phase}`;
    if (appended.has(key)) return;
    appended.add(key);
    if (events.length > 0) spool.appendAndRecord(sessionId, events);
  }

  /** Drain a session's spooled events. Undefined when they all reached the Deployment; else the class that stopped them. */
  async function drain(spool: MemberSpool, sessionId: string, client: ServerClient): Promise<string | undefined> {
    const drained = await spool.drainSession(sessionId, client, unboundedBudget(), { now, force: true });
    if (drained.endedBy === 'drained') return undefined;
    if (drained.endedBy === 'refused') {
      const refused = spool.readRefused().entries.filter((e) => e.sessionId === sessionId);
      const last = refused[refused.length - 1];
      if (last !== undefined && REFUSAL_SUBJECT[last.code] === 'server-version') {
        throw new ServerTooOld(`${membershipUrl()} refused ${last.kind} (${last.code}: ${last.reason}); update the Deployment before importing a 1.4 vault`);
      }
    }
    return drained.endedBy;
  }
}

/** An answer to a spore route: stopped (retryable or not), refused with a reason, or recorded. */
function classified(outcome: Outcome): { endedBy?: string; refusal?: string; duplicate?: boolean; body?: Record<string, unknown> } {
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
