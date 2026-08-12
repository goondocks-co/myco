import { readFile } from 'node:fs/promises';
import type { Database } from 'bun:sqlite';
import { findTranscriptFor } from '../../symbionts/transcript-discovery.js';
import { skeletonizeTranscript } from './skeletonize.js';
import type { BundleFile, CollectorError, DiagnosticWindow } from './types.js';

/**
 * One skeleton per session in the window. transcript_path from the vault is
 * primary; manifest-driven discovery is the fallback for sessions where no
 * hook ever reported a path — "hook never fired" is itself a capture-failure
 * mode under diagnosis, so the fallback is load-bearing, not a nicety.
 */
export async function collectTranscripts(opts: {
  db: Database;
  window: DiagnosticWindow;
  includeContent: boolean;
}): Promise<{ files: BundleFile[]; notes: string[]; errors: CollectorError[] }> {
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
        discovered = findTranscriptFor(s.agent, s.id);
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
    try {
      await new Promise((resolve) => setImmediate(resolve)); // yield per file
      const raw = await readFile(resolved, 'utf8');
      files.push({ path: `transcripts/${s.id}.skeleton.jsonl`, data: skeletonizeTranscript(raw) });
      if (opts.includeContent) files.push({ path: `transcripts/${s.id}.full.jsonl`, data: raw });
    } catch (err) {
      errors.push({ layer: `transcript:${s.id}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { files, notes, errors };
}
