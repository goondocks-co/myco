/**
 * The retained read verbs for a joined project — `search`, `vectors`,
 * `session` and `stats` — answered by the Deployment.
 *
 * Each verb is a presentation over the served MCP tools (`myco_search`,
 * `myco_sessions`, `myco_cortex`, `myco_agent`) called on the Deployment's
 * `/mcp` with the member credential, the same chokepoint an agent's tool call
 * reaches, so a person and an agent asking the same question get the same
 * answer. `stats` also reads the Deployment's health — schema, this
 * credential's quota and storage — from the member route `POST /members/status`,
 * which no MCP tool serves. Nothing here opens a vault, a database or the local
 * daemon, and `tests/meta/member-read-boundary.test.ts` holds the import
 * closure to that.
 *
 * Routing and the credential, its renewal included, are the member verbs'
 * shared reader's (`cli/deployment-reader.ts`).
 */
import { CONTENT_SNIPPET_CHARS } from '../constants.js';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { membershipProblem, openDeployment, ROUTE_MISSING, type DeploymentHandle, type MemberVerbDeps } from './deployment-reader.js';
import type { MemberReadVerb } from './member-verbs.js';

export { MEMBER_READ_VERBS, isMemberReadVerb, type MemberReadVerb } from './member-verbs.js';

/** Results a `search` shows. */
export const SEARCH_LIMIT = 10;
/** Results a `vectors` shows. */
export const VECTORS_LIMIT = 20;
/** Recent sessions a short session id is matched against. */
export const SESSION_PREFIX_WINDOW = 100;
/** Recent runs `stats` summarises. */
export const STATS_RUN_WINDOW = 20;
/** The member route that answers the Deployment's health: schema, this credential's quota, and storage. */
export const STATUS_READ_PATH = '/members/status';
/** The share of the top score a `vectors` result must reach to be marked as passing the default threshold. */
const VECTORS_RELATIVE_THRESHOLD = 0.5;

/** A tool answer that reports a failure in its body rather than as an error: `{ ok: false, error }`. */
function answeredFailure(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || (value as { ok?: unknown }).ok !== false) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' ? error : 'the Deployment answered a failure';
}

type Out = (line: string) => void;

/** A tool's answer, or null with the failure written to stderr under the verb's name. */
async function ask(reader: DeploymentHandle, verb: MemberReadVerb, err: Out, tool: string, args: Record<string, unknown>): Promise<unknown | null> {
  const outcome = await reader.call(tool, args);
  if (!outcome.ok) {
    err(`myco ${verb}: ${reader.serverUrl} did not answer ${tool} (${outcome.error.code}): ${outcome.error.message}`);
    return null;
  }
  const failed = answeredFailure(outcome.value);
  if (failed !== null) {
    err(`myco ${verb}: ${reader.serverUrl} answered ${tool} with a failure: ${failed}`);
    return null;
  }
  return outcome.value;
}

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'never');

const sourceLine = (reader: DeploymentHandle): string => `Deployment: ${reader.serverUrl}  project: ${reader.projectId}`;

interface SearchHit { id: string; type: string; title?: string; preview?: string; score: number }
interface SearchAnswer { results: SearchHit[]; mode: string; provider_unavailable: boolean }

async function runSearch(reader: DeploymentHandle, query: string, out: Out, err: Out): Promise<boolean> {
  const answer = await ask(reader, 'search', err, 'myco_search', { query, limit: SEARCH_LIMIT }) as SearchAnswer | null;
  if (answer === null) return false;
  out(`=== Search: "${query}" ===`);
  out(sourceLine(reader));
  out(`Mode: ${answer.mode}${answer.provider_unavailable ? ' (semantic search unavailable on this Deployment)' : ''}`);
  if (answer.results.length === 0) out('  (no results)');
  for (const hit of answer.results) out(`  [${hit.type}] ${(hit.preview || hit.title || '').slice(0, CONTENT_SNIPPET_CHARS)}`);
  return true;
}

async function runVectors(reader: DeploymentHandle, query: string, out: Out, err: Out): Promise<boolean> {
  const answer = await ask(reader, 'vectors', err, 'myco_search', { query, mode: 'semantic', limit: VECTORS_LIMIT }) as SearchAnswer | null;
  if (answer === null) return false;
  if (answer.provider_unavailable) {
    err(`myco vectors: semantic search is unavailable on ${reader.serverUrl} — the Deployment has no embedding provider configured`);
    return false;
  }
  out(`Query: "${query}"`);
  out(sourceLine(reader));
  out('');
  if (answer.results.length === 0) {
    out('(no results)');
    return true;
  }
  const top = answer.results[0].score;
  out(`Top score: ${top.toFixed(4)}`);
  out(`Default threshold (${VECTORS_RELATIVE_THRESHOLD}x): ${(top * VECTORS_RELATIVE_THRESHOLD).toFixed(4)}`);
  out('');
  out('  Sim     Ratio  Type       ID');
  out('  ------  -----  ---------  ' + '-'.repeat(50));
  for (const hit of answer.results) {
    const pass = hit.score >= top * VECTORS_RELATIVE_THRESHOLD ? '✓' : ' ';
    out(`${pass} ${hit.score.toFixed(4)}  ${(top === 0 ? 0 : hit.score / top).toFixed(2)}   ${(hit.type ?? 'unknown').padEnd(9)}  ${hit.id.slice(0, 50)}`);
  }
  return true;
}

interface SessionSummary {
  id: string; status: string; title: string | null; branch: string | null; user: string | null; agent: string | null;
  started_at: number | null; ended_at: number | null; prompt_count: number; tool_count: number; summary: string;
}

async function runSession(reader: DeploymentHandle, idOrLatest: string | undefined, out: Out, err: Out): Promise<boolean> {
  let id = idOrLatest;
  if (id === undefined || id === 'latest') {
    const latest = await ask(reader, 'session', err, 'myco_sessions', { op: 'list', limit: 1 }) as SessionSummary[] | null;
    if (latest === null) return false;
    if (latest.length === 0) {
      out(sourceLine(reader));
      out('No sessions found');
      return true;
    }
    id = latest[0].id;
  }
  let outcome = await reader.call('myco_sessions', { op: 'get', id });
  if (outcome.ok && answeredFailure(outcome.value) !== null) {
    // A short id is matched against the recent sessions, and must name exactly one.
    const recent = await ask(reader, 'session', err, 'myco_sessions', { op: 'list', limit: SESSION_PREFIX_WINDOW }) as SessionSummary[] | null;
    if (recent === null) return false;
    const prefix = id;
    const matches = recent.filter((s) => s.id.startsWith(prefix));
    if (matches.length !== 1) {
      err(matches.length === 0
        ? `myco session: no session ${prefix} on ${reader.serverUrl} for project ${reader.projectId}`
        : `myco session: ${prefix} names ${matches.length} sessions (${matches.map((s) => s.id).join(', ')}); give more of the id`);
      return false;
    }
    outcome = await reader.call('myco_sessions', { op: 'get', id: matches[0].id });
  }
  if (!outcome.ok) {
    err(`myco session: ${reader.serverUrl} did not answer myco_sessions (${outcome.error.code}): ${outcome.error.message}`);
    return false;
  }
  const failed = answeredFailure(outcome.value);
  if (failed !== null) {
    err(`myco session: ${reader.serverUrl} answered myco_sessions with a failure: ${failed}`);
    return false;
  }
  const s = outcome.value as SessionSummary;
  out(sourceLine(reader));
  out(`Session: ${s.id}`);
  out(`Status:  ${s.status}`);
  if (s.title) out(`Title:   ${s.title}`);
  if (s.agent) out(`Agent:   ${s.agent}`);
  if (s.branch) out(`Branch:  ${s.branch}`);
  if (s.user) out(`User:    ${s.user}`);
  out(`Started: ${iso(s.started_at)}`);
  if (s.ended_at) out(`Ended:   ${iso(s.ended_at)}`);
  out(`Prompts: ${s.prompt_count}`);
  out(`Tools:   ${s.tool_count}`);
  if (s.summary) out(`\nSummary:\n${s.summary}`);
  return true;
}

interface ProjectActivity { id: string; name: string | null; session_count: number; last_activity_at: number | null; active: boolean }
interface RunRow { task: string | null; status: string; started_at: number | null; queued_at: number | null; completed_at: number | null }

/** A byte count the Deployment measured, or why it could not. */
type ByteFact = { state: 'measured'; value: number; unit: 'bytes' } | { state: 'unavailable'; reason: string };
type StorageFact = ByteFact & { name: string; measuredAt: number | null };
interface DeploymentHealth {
  target: string | null;
  schema: { expected: number; found: number | null };
  quota: { used: ByteFact; limit: ByteFact };
  storage: StorageFact[];
}

/** The Deployment's health over its member route, or why it is unavailable and whether that is a failure. */
async function readHealth(reader: DeploymentHandle): Promise<{ ok: true; health: DeploymentHealth } | { ok: false; reason: string; failed: boolean }> {
  const answer = await reader.post(STATUS_READ_PATH, {});
  if (!answer.ok) {
    return answer.error.code === ROUTE_MISSING
      ? { ok: false, reason: 'this Deployment does not report health yet; update it', failed: false }
      : { ok: false, reason: `${reader.serverUrl} did not answer (${answer.error.code}): ${answer.error.message}`, failed: true };
  }
  const health = answer.value as Partial<DeploymentHealth>;
  if (health.schema === undefined || health.quota === undefined || !Array.isArray(health.storage)) {
    return { ok: false, reason: `${reader.serverUrl} answered without its schema, quota and storage`, failed: true };
  }
  return { ok: true, health: health as DeploymentHealth };
}

const byteCount = (n: number): string => `${n.toLocaleString('en-US')} bytes`;
/** A fact as a line reads it; a state this CLI does not know is named rather than guessed at. */
const fact = (f: { state: string; value?: number; reason?: string }): string => {
  if (f.state === 'measured' && typeof f.value === 'number') return byteCount(f.value);
  if (f.state === 'unavailable') return `unavailable: ${f.reason ?? 'no reason given'}`;
  return `not understood by this CLI (state ${JSON.stringify(f.state)}); update it`;
};
/** How a storage measurement is labelled; a name with no label here is shown as sent. */
const MEASUREMENT_LABEL: Record<string, string> = { blob_bytes: 'Blobs', size: 'Database', reclaimable: 'Reclaimable', size_limit: 'Size limit', daily_quota: 'Daily quota' };
/** The column the health values start at: the longest known label, its colon and a space; a longer label keeps one space. */
const HEALTH_COLUMN = 13;
const healthLine = (label: string, value: string): string => `${`${label}:`.padEnd(HEALTH_COLUMN - 1)} ${value}`;

async function runStats(reader: DeploymentHandle, out: Out, err: Out): Promise<boolean> {
  const activity = await ask(reader, 'stats', err, 'myco_cortex', { op: 'projects_activity' }) as { projects: ProjectActivity[] } | null;
  if (activity === null) return false;
  const runs = await ask(reader, 'stats', err, 'myco_agent', { op: 'runs', limit: STATS_RUN_WINDOW }) as { data: { runs: RunRow[] } } | null;
  if (runs === null) return false;
  const read = await readHealth(reader);
  if (!read.ok && read.failed) err(`myco stats: health unavailable: ${read.reason}`);
  const project = activity.projects.find((p) => p.id === reader.projectId) ?? null;

  out('=== Myco Deployment ===');
  out(`Deployment: ${reader.serverUrl}`);
  if (read.ok) out(`Target:     ${read.health.target ?? 'unavailable: the Deployment names no target'}`);
  out(`Project:    ${reader.projectId}${project?.name ? ` (${project.name})` : ''}`);
  out(`Projects:   ${activity.projects.length} on this Deployment`);

  out('\n--- Health ---');
  if (!read.ok) {
    out(healthLine('Health', `unavailable: ${read.reason}`));
  } else {
    const { schema, quota, storage } = read.health;
    out(healthLine('Schema', `expected ${schema.expected}, found ${schema.found ?? 'unavailable: the store answered no version'}`));
    out(healthLine('Quota', `${fact(quota.used)} used of ${fact(quota.limit)} (this machine's credential)`));
    for (const m of storage) {
      out(healthLine(MEASUREMENT_LABEL[m.name] ?? m.name, `${fact(m)}${typeof m.measuredAt === 'number' ? ` (measured ${iso(m.measuredAt)})` : ''}`));
    }
  }

  out('\n--- Data ---');
  out(`Sessions:      ${project?.session_count ?? 0}`);
  out(`Last activity: ${iso(project?.last_activity_at)}`);
  out(`Active:        ${project?.active ? 'yes' : 'no'} (activity in the last seven days)`);

  out(`\n--- Agent runs (latest ${STATS_RUN_WINDOW}) ---`);
  const rows = runs.data.runs;
  if (rows.length === 0) {
    out('No runs yet');
  } else {
    const last = rows[0];
    out(`Last run:   ${iso(last.started_at ?? last.queued_at)} ${last.task ?? 'unknown task'} (${last.status})`);
    const byStatus = new Map<string, number>();
    for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    out(`By status:  ${[...byStatus].map(([status, n]) => `${status} ${n}`).join(', ')}`);
  }
  return read.ok || !read.failed;
}

const USAGE: Record<MemberReadVerb, string> = {
  search: 'Usage: myco search <query>',
  vectors: 'Usage: myco vectors <query>',
  session: 'Usage: myco session [id|latest]',
  stats: 'Usage: myco stats',
};

/**
 * Answer one read verb from the Deployment over `source`. True when the verb
 * answered; false after a usage error, a credential that resolves nowhere, or
 * a Deployment that refused or failed the call — each written to stderr.
 */
export async function run(verb: MemberReadVerb, args: readonly string[], source: CredentialSource, deps: MemberVerbDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const operands = withoutCredentialFlag(args);
  const query = operands.join(' ').trim();
  if ((verb === 'search' || verb === 'vectors') && query.length === 0) { err(USAGE[verb]); return false; }
  if (verb === 'stats' && operands.length > 0) { err(USAGE.stats); return false; }
  if (verb === 'session' && operands.length > 1) { err(USAGE.session); return false; }

  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) { err(`myco ${verb}: ${problem}`); return false; }
  const reader = await openDeployment(source, deps);
  if (reader === null) {
    err(`myco ${verb}: no member credential resolves for this project (--credential ${source}); the reason is above`);
    return false;
  }
  switch (verb) {
    case 'search': return runSearch(reader, query, out, err);
    case 'vectors': return runVectors(reader, query, out, err);
    case 'session': return runSession(reader, operands[0], out, err);
    case 'stats': return runStats(reader, out, err);
  }
}
