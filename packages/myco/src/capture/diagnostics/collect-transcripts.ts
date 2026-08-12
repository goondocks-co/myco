import { readFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { findTranscriptFor } from '../../symbionts/transcript-discovery.js';
import { safePathSegment } from './safe-path.js';
import { skeletonizeTranscript } from './skeletonize.js';
import type { BundleFile, CollectorError, DiagnosticWindow } from './types.js';

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * One skeleton per session in the window. transcript_path from the vault is
 * primary; manifest-driven discovery is the fallback in two situations:
 * no hook ever reported a path ("hook never fired" is itself a
 * capture-failure mode under diagnosis), or a recorded path exists but no
 * longer resolves on disk (ENOENT) — e.g. a worktree-suffixed project
 * directory that was since removed, or a moved project root. Only when
 * BOTH the recorded path and discovery fail to produce a readable file does
 * this record a `CollectorError`.
 */
export async function collectTranscripts(opts: {
  db: Database;
  window: DiagnosticWindow;
  includeContent: boolean;
  /** Injection seam for tests; defaults to manifest-driven `findTranscriptFor`. */
  discover?: (agent: string, sessionId: string) => string | null;
}): Promise<{ files: BundleFile[]; notes: string[]; errors: CollectorError[] }> {
  const discover = opts.discover ?? findTranscriptFor;
  const files: BundleFile[] = [];
  const notes: string[] = [];
  const errors: CollectorError[] = [];

  const sessions = opts.db
    .query(
      `SELECT id, agent, transcript_path FROM sessions
       WHERE started_at <= $until AND COALESCE(ended_at, started_at) >= $since`,
    )
    .all({ $since: opts.window.since, $until: opts.window.until }) as Array<{
    id: string;
    agent: string;
    transcript_path: string | null;
  }>;

  for (const s of sessions) {
    let discovered: string | null = null;
    if (!s.transcript_path) {
      try {
        discovered = discover(s.agent, s.id);
      } catch (err) {
        notes.push(
          `session ${s.id}: transcript discovery threw for agent=${s.agent}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const resolved = s.transcript_path ?? discovered;
    if (!resolved) {
      notes.push(`session ${s.id}: no transcript path recorded and discovery found none (agent=${s.agent})`);
      continue;
    }
    if (!s.transcript_path) {
      notes.push(`session ${s.id}: transcript_path missing in vault; found via discovery — hook may never have fired`);
    }
    const { segment, sanitized } = safePathSegment(s.id);
    if (sanitized) notes.push(`session ${segment}: unsafe session id sanitized in bundle paths`);

    let raw: string;
    try {
      await new Promise((resolve) => setImmediate(resolve)); // yield per file
      raw = await readFile(resolved, 'utf8');
    } catch (err) {
      // The recorded path is stale (worktree removed, project moved, etc.)
      // — retry via discovery before giving up. Discovery is only attempted
      // here for a RECORDED path that ENOENTs; a path already produced by
      // discovery above failing again would just repeat the same lookup.
      const staleRecordedPath = Boolean(s.transcript_path) && isEnoent(err);
      let fallbackPath: string | null = null;
      if (staleRecordedPath) {
        try {
          fallbackPath = discover(s.agent, s.id);
        } catch {
          fallbackPath = null;
        }
      }
      if (!fallbackPath) {
        errors.push({ layer: `transcript:${segment}`, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      try {
        raw = await readFile(fallbackPath, 'utf8');
        notes.push(
          `session ${s.id}: recorded transcript_path missing on disk; found via discovery — path may be stale (worktree or moved project)`,
        );
      } catch (fallbackErr) {
        errors.push({
          layer: `transcript:${segment}`,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        continue;
      }
    }

    files.push({ path: `transcripts/${segment}.skeleton.jsonl`, data: skeletonizeTranscript(raw) });
    if (opts.includeContent) files.push({ path: `transcripts/${segment}.full.jsonl`, data: raw });
  }
  return { files, notes, errors };
}
