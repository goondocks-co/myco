/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Content claim system — member disk truth (design §2(b)).
 *
 *   POST /api/content-claims/file-status   { project_root, artifacts: [{ artifact_kind, artifact_id, name }] }
 *
 * Reports, per requested artifact, whether its expected file is present in
 * the CALLING member's own working tree. Read-only sibling of the
 * materialize route (`content-claims-materialize.ts`): same
 * `resolveMemberProjectContext` prelude, same `localhost-only` posture (a
 * disk-presence check is scoped to the member's own checkout, never proxied
 * to the host), but this route never writes. `host/routing.ts` stamps it
 * alongside materialize, sharing its capability so the two travel together.
 *
 * The UI merges this "disk truth" with the inventory route's (`content-claims.ts`
 * `published` array) "DB truth" to re-offer Publish for a published skill whose
 * file was deleted from the working tree (e.g. by `git rm` or a branch switch).
 */
import fs from 'node:fs';

import { resolvePublishedSkillPaths } from '@myco/skills/publication.js';

import type { ProxyLogger } from '../host-proxy.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';
import { resolveMemberProjectContext } from './member-project-context.js';

/** Requests larger than this are rejected outright (413) before any
 *  per-artifact work — a batch this size is never a legitimate UI call. */
const MAX_ARTIFACTS = 1000;

interface FileStatusArtifactInput {
  artifact_kind?: unknown;
  artifact_id?: unknown;
  name?: unknown;
}

interface FileStatusResult {
  artifact_kind: string | null;
  artifact_id: string | null;
  file_present: boolean | null;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function asArtifactsArray(body: Record<string, unknown>): unknown[] {
  const raw = body.artifacts;
  return Array.isArray(raw) ? raw : [];
}

/** A batch entry that isn't a plain object (null, string, number, boolean,
 *  array) carries no artifact identity at all — distinct from a well-formed
 *  entry with a bad field, which still echoes its own kind/id. */
function isArtifactObject(entry: unknown): entry is FileStatusArtifactInput {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry);
}

/**
 * Disk-presence check for one requested artifact. Never throws: an unknown
 * kind (only `skill` is ever recognized — the claim system's other historical
 * kind is retired) degrades to `null` silently, a routine, expected shape;
 * a resolver refusal (traversal/absolute/empty name) or any other
 * per-artifact failure degrades to `null` with exactly one `warn` log.
 * Either way a bad entry never fails the batch.
 */
function fileStatusForArtifact(
  currentRoot: string,
  artifact: FileStatusArtifactInput,
  logger: ProxyLogger,
): boolean | null {
  try {
    if (artifact.artifact_kind !== 'skill') return null;

    if (typeof artifact.name !== 'string' || artifact.name.length === 0) {
      logger.warn('file-status: refused a skill artifact with a non-string or empty name', {
        artifact_id: artifact.artifact_id,
      });
      return null;
    }

    const resolved = resolvePublishedSkillPaths(currentRoot, artifact.name);
    if (!resolved.ok) {
      logger.warn('file-status: resolver refused a published skill path', {
        artifact_id: artifact.artifact_id,
        reason: resolved.reason,
      });
      return null;
    }

    return fs.existsSync(resolved.paths.skillPath);
  } catch (err) {
    logger.warn('file-status: unexpected failure checking a published skill path', {
      artifact_id: artifact.artifact_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A request entry's `artifact_kind`/`artifact_id` echoed back typed, not
 *  raw — a non-string value (number, object, array) has no valid identity
 *  to echo and degrades to `null` rather than leaking an arbitrary JSON
 *  shape into a `string | null` wire field. */
function asEchoString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One response entry per request entry, index-aligned. A non-object entry
 * (e.g. a literal `null` in the artifacts array) has no identity to echo —
 * it degrades to `{artifact_kind: null, artifact_id: null, file_present: null}`
 * with one `warn` log, keeping the batch alive and the alignment intact.
 */
function statusForEntry(currentRoot: string, entry: unknown, logger: ProxyLogger): FileStatusResult {
  if (!isArtifactObject(entry)) {
    logger.warn('file-status: refused a non-object artifact entry', {
      entry_type: entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry,
    });
    return { artifact_kind: null, artifact_id: null, file_present: null };
  }
  return {
    artifact_kind: asEchoString(entry.artifact_kind),
    artifact_id: asEchoString(entry.artifact_id),
    file_present: fileStatusForArtifact(currentRoot, entry, logger),
  };
}

export interface ContentClaimFileStatusDeps {
  logger: ProxyLogger;
  mycoHome?: string;
}

export function createContentClaimFileStatusHandler(deps: ContentClaimFileStatusDeps): RouteHandler {
  return async (req): Promise<RouteResponse> => {
    const body = asRecord(req.body);

    const context = await resolveMemberProjectContext(req, body, deps.mycoHome);
    if ('status' in context) {
      return context;
    }

    const artifacts = asArtifactsArray(body);
    if (artifacts.length > MAX_ARTIFACTS) {
      return {
        status: 413,
        body: errorBody('too_many_artifacts', `At most ${MAX_ARTIFACTS} artifacts may be checked per request.`),
      };
    }

    const statuses: FileStatusResult[] = artifacts.map((entry) =>
      statusForEntry(context.currentRoot, entry, deps.logger));

    return { status: 200, body: { statuses } };
  };
}

/** Register the file-status route on the daemon server. */
export function registerContentClaimFileStatusRoute(
  server: RouteRegistrar,
  deps: ContentClaimFileStatusDeps,
): void {
  server.registerRoute('POST', '/api/content-claims/file-status', createContentClaimFileStatusHandler(deps));
}
