import fs from 'node:fs';
import type { Database } from 'bun:sqlite';

import { evaluateSessionCaptureRules, resolveSubagentThread } from '../../../hooks/capture-rules.js';
import { readTranscriptMeta } from '../../../hooks/transcript-meta.js';
import { manifestTranscriptDiscovery, enumerateTranscripts } from '../../../symbionts/transcript-discovery.js';
import { classifyRecency } from '../context.js';
import type { AuditOptions, CoverageGap, Finding, SymbiontContext } from '../types.js';

/**
 * Reverse sweep: transcripts on disk with no session row at all.
 *
 * Hooks can only report a transcript that they fired for, so forward-only
 * checking is blind to whole-session loss by construction — if the hook never
 * ran, nothing in the vault points at the file. This is the direction that
 * finds it.
 */

const MAX_HEADER_LINES = 40;

function readDotPath(source: unknown, dotPath: string): string | null {
  let current: unknown = source;
  for (const key of dotPath.split('.')) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : null;
}

/**
 * True when this transcript is one Myco deliberately does not give a session
 * row of its own.
 *
 * Two distinct reasons, both correct, and both indistinguishable from loss if
 * you only look at the database:
 *
 *  1. A sub-agent thread. Its turns are mined and reattributed to the PARENT
 *     session, so the content is captured even though the child transcript has
 *     no row. Sub-agents are the same session, not a child session.
 *  2. A manifest drop rule — `codex exec` runs, ephemeral sub-invocations.
 *
 * This mirrors `TranscriptMiner.transcriptGate`'s order exactly (sub-agent
 * resolution first, drop rules second) and calls the same helpers, so the
 * audit cannot disagree with what capture actually did.
 */
export function intentionallyDropped(agent: string, filePath: string): boolean {
  try {
    const meta = readTranscriptMeta(filePath) ?? undefined;

    const thread = resolveSubagentThread(agent, meta);
    if (thread?.threadId) return true;

    const decision = evaluateSessionCaptureRules(agent, {
      transcriptPath: filePath,
      ...(meta ? { transcriptMeta: meta } : {}),
    });
    return decision.action === 'drop';
  } catch {
    return false;
  }
}

/**
 * Attribute a transcript to a project from its own path.
 *
 * Agents that record no working directory inside the transcript often encode
 * it in the directory layout instead — Cursor stores under a
 * `Users-chris-Repos-myco` slug, Claude Code under `-Users-chris-Repos-myco`.
 * Matching a slugified project root against whole path segments recovers the
 * project without knowing any agent's convention, so it needs no per-agent
 * code and works for any agent that happens to slug its paths.
 *
 * Whole-segment matching matters: a substring test would let `/repo/app`
 * claim transcripts belonging to `/repo/app-server`.
 */
export function attributeByPathSlug(filePath: string, projectRoots: Iterable<string>): string | null {
  const segments = new Set(filePath.split('/').filter(Boolean));
  for (const root of projectRoots) {
    const slug = root.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '');
    if (!slug) continue;
    // Both bare and leading-dash conventions are in use.
    if (segments.has(slug) || segments.has(`-${slug}`)) return root;
  }
  return null;
}

/** The working directory a transcript records, if its manifest declares where. */
export function transcriptCwd(filePath: string, cwdPath: string): string | null {
  let handle: number;
  try {
    handle = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    // Header only: the cwd appears in the first few entries and these files
    // reach tens of megabytes.
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n').slice(0, MAX_HEADER_LINES);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const found = readDotPath(JSON.parse(line), cwdPath);
        if (found) return found;
      } catch {
        // Partial trailing line, or an entry that is not JSON.
      }
    }
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

export function checkReconcile(
  db: Database,
  opts: AuditOptions,
  now: number,
  symbionts: SymbiontContext[],
): { findings: Finding[]; coverage: CoverageGap[] } {
  const findings: Finding[] = [];
  const coverage: CoverageGap[] = [];

  const projectRoots = new Map<string, string>();
  for (const row of db
    .query(`SELECT DISTINCT project_id, project_root FROM sessions WHERE project_root IS NOT NULL`)
    .all() as Array<{ project_id: string | null; project_root: string }>) {
    if (row.project_id) projectRoots.set(row.project_root, row.project_id);
  }

  for (const symbiont of symbionts) {
    if (opts.symbiont && symbiont.name !== opts.symbiont) continue;

    if (symbiont.model === 'plugin-reported') {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'transcript reconciliation',
        reason:
          'Plugin-reported: its Myco plugin posts complete events to the daemon and leaves no transcript to mine, so a NULL transcript_path is correct rather than a gap.',
      });
      continue;
    }

    const discovery = manifestTranscriptDiscovery(symbiont.name);
    if (!discovery) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'transcript reconciliation',
        reason: 'Mines transcripts but declares no capture.transcriptDiscovery, so disk cannot be enumerated.',
      });
      continue;
    }

    const limit = opts.transcriptLimit ?? 2000;
    const onDisk = enumerateTranscripts(discovery, limit);
    if (onDisk.length >= limit) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'transcript reconciliation',
        reason: `Enumeration hit the ${limit}-transcript cap, so older transcripts were not examined.`,
      });
    }

    const known = new Set(
      (db.query(`SELECT id FROM sessions WHERE agent = $agent`).all({ $agent: symbiont.name }) as Array<{
        id: string;
      }>).map((r) => r.id),
    );

    const orphans = onDisk.filter((t) => !known.has(t.sessionId));
    if (orphans.length === 0) continue;

    const attributed: string[] = [];
    let unattributable = 0;
    let deliberate = 0;
    for (const orphan of orphans) {
      // A transcript the manifest refuses to register is absent by design.
      if (intentionallyDropped(symbiont.name, orphan.filePath)) {
        deliberate += 1;
        continue;
      }
      // Recorded cwd is the strongest signal; the path slug recovers projects
      // for agents that record none.
      const cwd = discovery.transcriptCwdPath
        ? transcriptCwd(orphan.filePath, discovery.transcriptCwdPath)
        : null;
      const root = cwd ?? attributeByPathSlug(orphan.filePath, projectRoots.keys());
      if (!root) {
        unattributable += 1;
        continue;
      }
      const projectId = projectRoots.get(root);
      if (!projectId) continue; // belongs to a project this grove does not track
      if (opts.projectId && projectId !== opts.projectId) continue;
      attributed.push(orphan.sessionId);
    }

    if (deliberate > 0) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'transcript reconciliation',
        reason: `${deliberate} transcript(s) have no session row by design — sub-agent threads whose turns are reattributed to the parent session, plus manifest-dropped classes (non-interactive exec, ephemeral sub-invocations). Excluded from findings.`,
      });
    }

    if (unattributable > 0) {
      coverage.push({
        symbiont: symbiont.name,
        scope: 'transcript reconciliation',
        reason: `${unattributable} orphan transcript(s) carried no readable working directory and were left unclassified.`,
      });
    }

    if (attributed.length > 0) {
      findings.push({
        id: 'transcript-never-captured',
        layer: 'pipeline',
        severity: 'high',
        title: `${symbiont.name}: transcripts on disk with no session row`,
        detail:
          'These sessions belong to a project this grove tracks, yet nothing in the vault references them — capture never ran for them at all. Check hook installation and the daemon claim for this agent.',
        count: attributed.length,
        symbiont: symbiont.name,
        recency: classifyRecency(now, now),
        samples: attributed.slice(0, 5),
      });
    }
  }

  return { findings, coverage };
}
