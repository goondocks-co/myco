import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME } from '../buffer.js';
import { sha256Hex } from './hash.js';
import { safePathSegment } from './safe-path.js';
import type { BundleFile } from './types.js';

const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/; // Lowercase identifiers (input `type`/`event_type` -> output `event_type`)
const UUID_PATTERN = /^[a-z0-9-]{1,64}$/; // Lowercase hex and hyphen (session_id)
const TIMESTAMP_PATTERN = /^[0-9TZz:.,+\- ]{1,40}$/; // ISO 8601 and variants

/**
 * Structure-only view of one raw capture-event line. Same allowlist
 * principle as skeletonize.ts's transcript skeletonizer: a fixed field set
 * built by construction, never a spread, so a field an evolving buffer
 * format adds later can't leak prose into a default bundle.
 */
export function skeletonizeBufferLine(line: string): Record<string, unknown> {
  const byte_length = Buffer.byteLength(line, 'utf8');
  let evt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { event_type: 'unparseable', timestamp: null, session_id: null, byte_length, content_hash: sha256Hex(line) };
    }
    evt = parsed as Record<string, unknown>;
  } catch {
    return { event_type: 'unparseable', timestamp: null, session_id: null, byte_length, content_hash: sha256Hex(line) };
  }

  // A live capture event's discriminator field is `type` (EventBody in
  // daemon/event-dispatch.ts: `z.object({ type: z.string(), session_id:
  // z.string() }).passthrough()`, and `EventBuffer.append` — buffer.ts —
  // persists that object verbatim; confirmed against buffer.test.ts
  // fixtures, e.g. `{ type: 'tool_use', tool: 'Read', ... }`). `event_type`
  // is kept as a fallback in case an older or alternate writer ever used
  // that name; the OUTPUT field below is always called `event_type`
  // regardless of which input name it was read from.
  const rawType = typeof evt.type === 'string'
    ? evt.type
    : typeof evt.event_type === 'string' ? evt.event_type : null;
  const event_type = rawType && TYPE_PATTERN.test(rawType) ? rawType : 'unknown';

  const rawTimestamp = typeof evt.timestamp === 'string' ? evt.timestamp : null;
  const timestamp = rawTimestamp && TIMESTAMP_PATTERN.test(rawTimestamp) ? rawTimestamp : null;

  const rawSessionId = typeof evt.session_id === 'string' ? evt.session_id : null;
  const session_id = rawSessionId && UUID_PATTERN.test(rawSessionId) ? rawSessionId : null;

  return { event_type, timestamp, session_id, byte_length, content_hash: sha256Hex(line) };
}

function skeletonizeBufferFile(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    out.push(JSON.stringify(skeletonizeBufferLine(line)));
  }
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

/**
 * A file listed by `listJsonl` can vanish before it's read — the daemon
 * drains/deletes a converged buffer concurrently with export, the same
 * race the honest-absence note exists for. Read failures are noted, not
 * thrown, since this collector's return shape has no error channel and one
 * missing file must not abort the whole bundle.
 */
function tryReadFile(filePath: string, sessionId: string, notes: string[]): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    notes.push(`session ${sessionId}: buffer read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Window-scoped live buffers (`<sessionId>.jsonl` for ids in
 * `sessionIdsInWindow` only) plus ALL quarantined buffers regardless of
 * window — quarantine is bounded to 7 days by the daemon's own
 * BUFFER_HARD_RETENTION_MS and is exactly the diverging-capture evidence
 * this bundle exists to surface. Buffer lines are raw capture events (may
 * contain prompts), so they're skeletonized by default like transcripts.
 *
 * Buffer dirs are located by directly joining
 * `groves/<groveId>/projects/<projectId>/buffer` (the same shape
 * `resolveProjectBufferDir` in grove/paths.ts builds) rather than calling
 * that resolver: this collector enumerates whatever project directories
 * exist on disk under the grove and must tolerate every name it finds,
 * while `resolveProjectBufferDir` asserts a branded Grove-era id
 * (`proj_<32 hex>`) and throws on anything else.
 */
export function collectBuffers(opts: {
  groveId: string;
  mycoHome: string;
  sessionIdsInWindow: string[];
  includeContent: boolean;
}): { files: BundleFile[]; notes: string[] } {
  const files: BundleFile[] = [];
  const notes: string[] = [];
  const collectedLiveIds = new Set<string>();

  const projectsDir = path.join(opts.mycoHome, 'groves', opts.groveId, 'projects');
  let projectIds: string[];
  try {
    projectIds = readdirSync(projectsDir);
  } catch {
    projectIds = [];
  }

  const windowIds = new Set(opts.sessionIdsInWindow);

  for (const projectId of projectIds) {
    const bufferDir = path.join(projectsDir, projectId, 'buffer');
    const { segment: projectSegment, sanitized: projectSanitized } = safePathSegment(projectId);
    if (projectSanitized) notes.push(`project ${projectSegment}: unsafe project id sanitized in bundle paths`);

    for (const name of listJsonl(bufferDir)) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (!windowIds.has(sessionId)) continue;

      const { segment: fileSegment, sanitized: fileSanitized } = safePathSegment(sessionId);
      if (fileSanitized) notes.push(`session ${fileSegment}: unsafe session id sanitized in bundle paths`);

      const raw = tryReadFile(path.join(bufferDir, name), sessionId, notes);
      if (raw === null) continue;
      collectedLiveIds.add(sessionId);
      files.push({
        path: `buffers/${projectSegment}/${fileSegment}.jsonl`,
        data: opts.includeContent ? raw : skeletonizeBufferFile(raw),
      });
    }

    const quarantineDir = path.join(bufferDir, BUFFER_QUARANTINE_DIRNAME);
    for (const name of listJsonl(quarantineDir)) {
      const sessionId = name.slice(0, -'.jsonl'.length);
      const { segment: fileSegment, sanitized: fileSanitized } = safePathSegment(sessionId);
      if (fileSanitized) notes.push(`session ${fileSegment}: unsafe session id sanitized in bundle paths`);

      const raw = tryReadFile(path.join(quarantineDir, name), sessionId, notes);
      if (raw === null) continue;
      files.push({
        path: `buffers/${projectSegment}/quarantine/${fileSegment}.jsonl`,
        data: opts.includeContent ? raw : skeletonizeBufferFile(raw),
      });
    }
  }

  for (const id of opts.sessionIdsInWindow) {
    if (!collectedLiveIds.has(id)) {
      notes.push(`session ${id}: no surviving buffer (converged buffers are deleted after drain)`);
    }
  }

  return { files, notes };
}
