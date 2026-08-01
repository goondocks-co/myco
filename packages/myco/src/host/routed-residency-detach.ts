/**
 * Team Host — the host side of the HYBRID detach (replaces the retired
 * page-pull of `routed-residency-pull.ts`).
 *
 * Two routes, both tenancy-bound the same way as the residency ingest:
 *
 *   - `POST /routed-capture/residency-detach-artifact` — build the detach
 *     artifact: a project-scoped SQL dump over {@link DETACH_ARTIFACT_TABLES}
 *     (the project's WHOLE knowledge; never the host roster) and return it in
 *     one response with its sha256. One file, digest-verified by the member —
 *     no cursor, no staging, no partial-apply window. Rebuilt fresh on every
 *     call (a crash-resumed fetch gets a coherent artifact, never a torn one);
 *     the transient dump file lives under the OS tmpdir and is removed before
 *     the response returns.
 *
 *   - `POST /routed-capture/residency-detach-complete` — the member's goodbye
 *     after its restore+flip landed. Runs the transition's host-side side
 *     effects, all idempotent (a replayed goodbye converges): release the
 *     departing machine's active content claims, prune ITS routed transcript
 *     trees (machine-scoped on purpose — other members' caches must survive),
 *     and — only when the project is a true stub (no rows from any machine
 *     other than the host's own or the departing member's) — deregister the
 *     hosted registry row and invalidate the host-serve status cache. The DB
 *     rows stay: detach is a copy-out, the team keeps its record (D-F-3).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { epochSeconds } from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { getDatabase, type Database } from '../db/client.js';
import { releaseActiveContentClaimsForMachine } from '../db/queries/content-claims.js';
import { projectHasForeignMachineRows } from '../db/queries/residency-pull.js';
import { invalidateHostServeStatusCache } from '../daemon/api/host-serve-status.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import type { Logger } from '../daemon/logger.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';
import { DETACH_ARTIFACT_TABLES, createBackup, projectScope } from '../backup/engine.js';
import { deregisterProjectInGrove } from '../grove/registry.js';
import { assertGroveProjectId, isGroveEraId } from '../grove/ids.js';
import { rowProjectIdFromRequestContext } from '../grove/request-context.js';
import { getTeamMachineId } from '../team/context.js';
import { resolveMycoHome } from '../grove/paths.js';
import { pruneRoutedTranscriptSessionsForMachine } from './routed-transcript.js';

/**
 * Neutralize the grove-lineage header line of a detach artifact, touching ONLY
 * the header block (everything before the first blank line) so a `-- grove_id:`
 * string inside row content is never mistaken for lineage. The dump is created
 * from the HOST's served-Grove DB, but its whole purpose is a restore into the
 * MEMBER's local Grove — the member re-stamps its own target grove id before
 * anything durable happens ({@link stampArtifactLineage}), so the lineage gate
 * keeps protecting the saved artifact instead of being skipped forever.
 */
export function neutralizeArtifactLineage(content: string): string {
  const headerEnd = content.indexOf('\n\n');
  if (headerEnd === -1) return content;
  const header = content.slice(0, headerEnd).replace(/^-- grove_id: .*\n?/m, '');
  return header + content.slice(headerEnd);
}

/**
 * Stamp the MEMBER's target grove id into an artifact header (replacing any
 * existing lineage line). Run before the artifact is restored or saved, so the
 * durable backup carries true lineage and `restoreBackup`'s cross-Grove gate
 * holds for it like any other dump.
 */
export function stampArtifactLineage(content: string, groveId: string): string {
  const stripped = neutralizeArtifactLineage(content);
  const headerEnd = stripped.indexOf('\n\n');
  const line = `-- grove_id: ${groveId}\n`;
  if (headerEnd === -1) return line + stripped;
  return stripped.slice(0, headerEnd) + '\n' + line.trimEnd() + stripped.slice(headerEnd);
}

/** Throttle window for repeated host-side detach warnings. */
const DETACH_LOG_INTERVAL_MS = 60_000;

/** One transfer chunk (pre-base64). Sized so a chunk response sits far inside
 *  the proxy body timeout on any plausible uplink. */
export const DETACH_ARTIFACT_CHUNK_BYTES = 2_000_000;

/** Honest ceiling for a single artifact. A project beyond it needs the
 *  operator's attention, not a silent forever-retry. */
export const MAX_DETACH_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

/** How long a built artifact stays servable before a fresh prepare rebuilds
 *  it. Long enough for any chunk loop + retries; short enough that an
 *  abandoned detach doesn't pin gigabytes of tmp. */
const ARTIFACT_CACHE_TTL_MS = 60 * 60 * 1000;

interface ArtifactCacheEntry {
  state: 'building' | 'ready' | 'error';
  filePath?: string;
  sha256?: string;
  size?: number;
  message?: string;
  builtAt: number;
}

/** Per-process artifact cache, keyed (project, machine). The build is the
 *  expensive step; chunks are cheap positional reads against the cached file.
 *  A host restart empties it — the member's chunk request then gets
 *  `restart: true` and re-prepares. */
const artifactCache = new Map<string, ArtifactCacheEntry>();

function cacheKey(projectId: string, machineId: string): string {
  return `${projectId}\u0000${machineId}`;
}

/** Test hook: drop all cached artifacts (and their files). */
export function _clearDetachArtifactCacheForTests(): void {
  for (const entry of artifactCache.values()) {
    if (entry.filePath) fs.rmSync(entry.filePath, { force: true });
  }
  artifactCache.clear();
}

function buildArtifact(db: Database, projectId: string, key: string): void {
  const entry: ArtifactCacheEntry = { state: 'building', builtAt: Date.now() };
  artifactCache.set(key, entry);
  try {
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-artifact-'));
    const dumpPath = createBackup(
      db, dumpDir, getTeamMachineId(), projectScope(assertGroveProjectId(projectId)),
      'detach', DETACH_ARTIFACT_TABLES,
    );
    const artifact = neutralizeArtifactLineage(fs.readFileSync(dumpPath, 'utf-8'));
    const size = Buffer.byteLength(artifact, 'utf-8');
    if (size > MAX_DETACH_ARTIFACT_BYTES) {
      fs.rmSync(dumpDir, { recursive: true, force: true });
      artifactCache.set(key, {
        state: 'error', builtAt: Date.now(),
        message: `the project's knowledge is larger than the ${Math.round(MAX_DETACH_ARTIFACT_BYTES / 1_073_741_824)} GB detach limit — contact the host operator`,
      });
      return;
    }
    const finalPath = path.join(dumpDir, 'artifact.sql');
    fs.writeFileSync(finalPath, artifact, 'utf-8');
    fs.rmSync(dumpPath, { force: true });
    artifactCache.set(key, {
      state: 'ready', builtAt: Date.now(), filePath: finalPath, size,
      sha256: crypto.createHash('sha256').update(artifact, 'utf-8').digest('hex'),
    });
  } catch (err) {
    artifactCache.set(key, { state: 'error', builtAt: Date.now(), message: (err as Error).message });
  }
}

/**
 * Build the detach-artifact handler — a prepare/chunk protocol so a real
 * project (tens of MB and up) transfers inside ordinary request timeouts:
 *
 *   `{op:'prepare'}` — build (or report) the one-time artifact. The build is
 *     synchronous inside the request (createBackup is synchronous), so a large
 *     project's FIRST prepare may outlive the member's request timeout — the
 *     host still finishes and caches, and the member's next-tick prepare
 *     answers `ready` instantly from the cache, so the transfer converges in
 *     at most one extra tick. Returns `{ready:true, sha256, size}` when
 *     servable, or a build error the member stamps. (A worker-thread build +
 *     `ready:false` polling is the post-v1 refinement; the wire shape already
 *     supports it.)
 *   `{op:'chunk', offset, sha256}` — one positional read of the cached file,
 *     base64-encoded. A sha mismatch or missing cache answers `{restart:true}`
 *     (host restarted / TTL expired / rebuilt) and the member re-prepares —
 *     resume is offset-based and durable on the member side.
 *
 * Runs inside the daemon's per-request `withDatabase` boundary, so
 * `getDatabase()` resolves to the served Grove.
 */
export function createRoutedDetachArtifactHandler(
  deps: { logger?: Logger } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;
    const machineId = req.requestContext?.machineId ?? null;
    if (!projectId || !machineId || !isGroveEraId(projectId, 'project')) {
      return { status: 400, body: { ok: false, error: 'missing_tenancy' } };
    }
    const body = (req.body ?? {}) as { op?: unknown; offset?: unknown; sha256?: unknown };
    const key = cacheKey(projectId, machineId);
    const entry = artifactCache.get(key);

    // TTL expiry: a stale ready artifact is dropped so a re-detach after a
    // long gap ships current knowledge, and abandoned tmp is reclaimed.
    if (entry && Date.now() - entry.builtAt > ARTIFACT_CACHE_TTL_MS) {
      if (entry.filePath) fs.rmSync(entry.filePath, { force: true });
      artifactCache.delete(key);
    }

    if (body.op === 'prepare') {
      const current = artifactCache.get(key);
      if (!current) {
        buildArtifact(getDatabase(), projectId, key);
        const after = artifactCache.get(key);
        if (after?.state === 'ready') {
          return { status: 200, body: { ok: true, ready: true, sha256: after.sha256, size: after.size } };
        }
        if (after?.state === 'error') {
          artifactCache.delete(key);
          if (shouldLogOncePerInterval(`residency.artifact_failed:${projectId}`, DETACH_LOG_INTERVAL_MS)) {
            deps.logger?.warn(LOG_KINDS.RESIDENCY_DETACH_PULL, 'Detach-artifact build failed — member will retry', {
              project_id: projectId, error: after.message,
            });
          }
          return { status: 500, body: { ok: false, error: 'artifact_failed', message: after.message } };
        }
        return { status: 200, body: { ok: true, ready: false } };
      }
      if (current.state === 'ready') {
        return { status: 200, body: { ok: true, ready: true, sha256: current.sha256, size: current.size } };
      }
      if (current.state === 'error') {
        artifactCache.delete(key);
        return { status: 500, body: { ok: false, error: 'artifact_failed', message: current.message } };
      }
      return { status: 200, body: { ok: true, ready: false } };
    }

    if (body.op === 'chunk') {
      const offset = typeof body.offset === 'number' && Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : null;
      const sha = typeof body.sha256 === 'string' ? body.sha256 : null;
      if (offset === null || !sha) return { status: 400, body: { ok: false, error: 'invalid_body' } };
      const current = artifactCache.get(key);
      if (!current || current.state !== 'ready' || current.sha256 !== sha || !current.filePath || !fs.existsSync(current.filePath)) {
        // Host restarted, TTL fired, or a different build — the member resets
        // its durable offset and re-prepares. Never a silent wrong-bytes serve.
        return { status: 200, body: { ok: true, restart: true } };
      }
      const size = current.size ?? 0;
      if (offset >= size) return { status: 400, body: { ok: false, error: 'invalid_offset' } };
      const length = Math.min(DETACH_ARTIFACT_CHUNK_BYTES, size - offset);
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(current.filePath, 'r');
      try { fs.readSync(fd, buf, 0, length, offset); } finally { fs.closeSync(fd); }
      const nextOffset = offset + length < size ? offset + length : null;
      return { status: 200, body: { ok: true, chunk: buf.toString('base64'), offset, next_offset: nextOffset } };
    }

    return { status: 400, body: { ok: false, error: 'invalid_body' } };
  };
}

/**
 * Departed-machine record for one hosted project — the durable fact "machine X
 * detached", which row attribution cannot answer (detach is a copy-out, so a
 * departed member's rows stay forever and would block the last-member reclaim
 * for any project two machines ever touched). Grove-scoped file beside the
 * served Grove's data; cleared when the project deregisters.
 */
function departedMachinesPath(groveId: string, projectId: string, mycoHome?: string): string {
  const base = mycoHome ?? resolveMycoHome();
  return path.join(base, 'groves', groveId, 'residency-departed', `${projectId}.json`);
}

function readDepartedMachines(groveId: string, projectId: string, mycoHome?: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(departedMachinesPath(groveId, projectId, mycoHome), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function recordDepartedMachine(groveId: string, projectId: string, machineId: string, mycoHome?: string): void {
  const filePath = departedMachinesPath(groveId, projectId, mycoHome);
  const current = new Set(readDepartedMachines(groveId, projectId, mycoHome));
  current.add(machineId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify([...current].sort()), 'utf-8');
}

/** The goodbye side effects, exported for the handler and its tests. */
export function runDetachCompleteSideEffects(
  db: Database,
  input: { groveId: string; projectId: string; machineId: string; mycoHome?: string; logger?: Logger },
): void {
  releaseActiveContentClaimsForMachine(input.machineId, input.projectId, epochSeconds());
  recordDepartedMachine(input.groveId, input.projectId, input.machineId, input.mycoHome);

  // Prune only the departing MACHINE's transcript trees for this project —
  // machine-scoped deliberately: other members' caches are still being mined.
  const sessionIds = (db.prepare(
    'SELECT id FROM sessions WHERE project_id = ? AND machine_id = ?',
  ).all(input.projectId, input.machineId) as { id: string }[]).map((r) => r.id);
  pruneRoutedTranscriptSessionsForMachine(input.machineId, sessionIds);

  // True-stub check: deregister the REGISTRY row only when no PRESENT member
  // still has rows here. Excluded: the host's own machine, the departing
  // member, and every machine that already said goodbye — their rows stay
  // forever (copy-out), so without the departed set the reclaim could never
  // fire once two machines had ever contributed.
  const hostMachineId = getTeamMachineId();
  const departed = readDepartedMachines(input.groveId, input.projectId, input.mycoHome);
  if (!projectHasForeignMachineRows(db, input.projectId, [hostMachineId, input.machineId, ...departed])) {
    deregisterProjectInGrove(input.groveId, input.projectId, input.mycoHome, { force: true });
    fs.rmSync(departedMachinesPath(input.groveId, input.projectId, input.mycoHome), { force: true });
    invalidateHostServeStatusCache();
    input.logger?.info(LOG_KINDS.RESIDENCY_DETACH_PULL, 'Deregistered stub project after detach', {
      project_id: input.projectId,
      grove_id: input.groveId,
    });
  }
}

/** Build the detach-complete (goodbye) handler. */
export function createRoutedDetachCompleteHandler(
  deps: { logger?: Logger; mycoHome?: string } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const groveId = req.requestContext?.groveId ?? null;
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;
    const machineId = req.requestContext?.machineId ?? null;
    if (!groveId || !projectId || !machineId) {
      return { status: 400, body: { ok: false, error: 'missing_tenancy' } };
    }
    try {
      runDetachCompleteSideEffects(getDatabase(), {
        groveId, projectId, machineId, mycoHome: deps.mycoHome, logger: deps.logger,
      });
      return { status: 200, body: { ok: true } };
    } catch (err) {
      if (shouldLogOncePerInterval(`residency.goodbye_failed:${projectId}`, DETACH_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_DETACH_PULL, 'Detach-complete side effects failed — member will retry', {
          project_id: projectId,
          error: (err as Error).message,
        });
      }
      return { status: 500, body: { ok: false, error: 'goodbye_failed', message: (err as Error).message } };
    }
  };
}
