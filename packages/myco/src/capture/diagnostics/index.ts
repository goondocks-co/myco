import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { SCHEMA_VERSION } from '../../db/schema.js';
import { queryLogs, type LogEntry } from '../../logs/reader.js';
import {
  collectAgentRuns,
  collectLogEntries,
  collectSessionRows,
  redactLogPayload,
} from './collect-vault.js';
import { collectAudit, collectDoctor, collectEnvironment } from './collect-system.js';
import { collectTranscripts } from './collect-transcripts.js';
import { collectBuffers } from './collect-buffers.js';
import { createZip } from './zip.js';
import { safePathSegment } from './safe-path.js';
import { resolveWindow } from './window.js';
import type { BundleFile, BundleManifest, CollectorError, DiagnosticWindow } from './types.js';

export interface BuildBundleOptions {
  groveId: string;
  /** Grove DB handle from GroveRuntimeCache. */
  db: Database;
  /** The daemon's BOOTSTRAP vault dir — doctor is project-vault-oriented, but this is what runChecks gets. */
  vaultDir: string;
  /** Path to the Grove's SQLite file on disk, for the read-only audit connection. */
  dbPath: string;
  mycoHome: string;
  /** resolveDaemonLogDir output. */
  logDir: string;
  /** Merged config; redacted inside collectEnvironment. */
  config: unknown;
  mycoVersion: string;
  window: { sessionId: string } | DiagnosticWindow;
  includeContent: boolean;
  narrative?: string;
  /** Default: resolveDiagnosticsRoot(). */
  outDir?: string;
}

/**
 * Thrown before any file work when the resolved window contains zero
 * sessions AND zero log entries — nothing to bundle. Carries up to 3
 * candidate sessions ranked by distance from the window midpoint so the
 * caller can suggest "did you mean one of these" instead of a bare error.
 */
export class EmptyWindowError extends Error {
  nearestSessions: Array<{ id: string; started_at: number }>;

  constructor(nearestSessions: Array<{ id: string; started_at: number }>) {
    super('Diagnostic window contains no sessions and no log entries');
    this.name = 'EmptyWindowError';
    this.nearestSessions = nearestSessions;
  }
}

/**
 * Resolve the root directory for diagnostic export bundles. Mirrors
 * `resolveBackupsRoot` (grove/paths.ts:92-97) in precedence and style:
 * explicit override, then `MYCO_DIAGNOSTICS_DIR`, then a home-relative
 * default. Defined here rather than in grove/paths.ts because diagnostics
 * are export artifacts, not Grove-scoped state.
 */
export function resolveDiagnosticsRoot(override?: string): string {
  if (override && override.trim().length > 0) return path.resolve(override);
  const env = process.env.MYCO_DIAGNOSTICS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), 'myco_diagnostics');
}

const LAYER_FILE_NAMES: Record<string, string> = {
  environment: 'environment.json',
  doctor: 'doctor.json',
  audit: 'audit-report.json',
  sessions: 'sessions.jsonl',
  'agent-runs': 'agent-runs.jsonl',
  'log-entries': 'log-entries.jsonl',
  'daemon-log': 'daemon-log.jsonl',
};

function layerFileName(layer: string): string {
  const name = LAYER_FILE_NAMES[layer];
  if (!name) throw new Error(`unknown diagnostic collector layer: ${layer}`);
  return name;
}

/** Same window predicate as collectSessionRows (collect-vault.ts:117-126), count-only. */
function countSessionsInWindow(db: Database, w: DiagnosticWindow): number {
  const row = db
    .query(
      `SELECT COUNT(*) as c FROM sessions
       WHERE started_at <= $until AND COALESCE(ended_at, started_at) >= $since`,
    )
    .get({ $since: w.since, $until: w.until }) as { c: number };
  return row.c;
}

/** Same window predicate as collectLogEntries (collect-vault.ts:199-209), count-only. */
function countLogEntriesInWindow(db: Database, w: DiagnosticWindow): number {
  const row = db
    .query(`SELECT COUNT(*) as c FROM log_entries WHERE timestamp >= $since AND timestamp <= $until`)
    .get({
      $since: new Date(w.since * 1000).toISOString(),
      $until: new Date(w.until * 1000).toISOString(),
    }) as { c: number };
  return row.c;
}

/**
 * Up to 3 sessions (any window) ranked by |started_at - window midpoint|,
 * closest first. Ordering and limiting happen in SQL, not in JS: the
 * empty-window error path runs before any file work, so a full-table
 * `SELECT` + JS sort would be a synchronous full-table scan on the daemon's
 * main loop for every rejected export.
 */
function nearestSessions(db: Database, w: DiagnosticWindow): Array<{ id: string; started_at: number }> {
  const midpoint = (w.since + w.until) / 2;
  return db
    .query(
      `SELECT id, started_at FROM sessions
       ORDER BY ABS(started_at - $mid)
       LIMIT 3`,
    )
    .all({ $mid: midpoint }) as Array<{ id: string; started_at: number }>;
}

/** Same window predicate as collectSessionRows, ids only — feeds collectBuffers' sessionIdsInWindow. */
function sessionIdsInWindow(db: Database, w: DiagnosticWindow): string[] {
  const rows = db
    .query(
      `SELECT id FROM sessions
       WHERE started_at <= $until AND COALESCE(ended_at, started_at) >= $since`,
    )
    .all({ $since: w.since, $until: w.until }) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * DaemonLogger always writes exactly these 5 fields verbatim on every entry
 * (logger.ts:200-207); everything else is caller-supplied metadata spread
 * flat onto the line (e.g. `prompt_preview`, event-dispatch.ts:538-547) —
 * unlike the `log_entries` table, which has a single dedicated `data`
 * column. `redactLogPayload` was written for that table's structural/data
 * split, so daemon.log lines are folded into the same shape (spread fields
 * -> a synthetic JSON `data` string) before being redacted, otherwise
 * `prompt_preview` would pass straight through as an unrecognized
 * "structural" field.
 *
 * `session_id`/`project_id` are added to the core set on top of
 * DaemonLogger's own 5: they're opaque structural ids, not prose, and they
 * already ship verbatim in sessions.jsonl (collect-vault.ts's
 * SESSION_STRUCTURAL_COLS/LOG_ENTRY_COLS) — hashing them here would sever
 * the cross-file join key that correlating a daemon-log line back to a
 * session is the whole reason this file is in the bundle.
 */
const DAEMON_LOG_CORE_FIELDS = new Set([
  'timestamp',
  'level',
  'kind',
  'component',
  'message',
  'session_id',
  'project_id',
]);

function toRedactableLogRow(entry: LogEntry): Record<string, unknown> {
  const structural: Record<string, unknown> = {};
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (DAEMON_LOG_CORE_FIELDS.has(key)) structural[key] = value;
    else payload[key] = value;
  }
  return { ...structural, data: Object.keys(payload).length > 0 ? JSON.stringify(payload) : null };
}

/**
 * Machine-global daemon.log, windowed and redacted. `includeContent` is
 * NEVER honored here (hardcoded `false` into `redactLogPayload`) — this log
 * is shared across every Grove the daemon serves, so it can carry another
 * Grove's prompt previews that the exporting user has no standing to
 * consent to disclose.
 */
function collectDaemonLog(logDir: string, w: DiagnosticWindow): string {
  const result = queryLogs(logDir, {
    since: new Date(w.since * 1000).toISOString(),
    until: new Date(w.until * 1000).toISOString(),
    limit: 10_000,
  });
  const rows = result.entries.map((entry) => redactLogPayload(toRedactableLogRow(entry), false));
  return rows.map((row) => JSON.stringify({ table: 'daemon_log', row })).join('\n') + (rows.length > 0 ? '\n' : '');
}

/** Wraps the async multi-file transcript collector so its own errors/notes fold into the shared arrays. */
async function collectTranscriptsSafe(
  opts: BuildBundleOptions,
  window: DiagnosticWindow,
  errors: CollectorError[],
  notes: string[],
): Promise<BundleFile[]> {
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const result = await collectTranscripts({ db: opts.db, window, includeContent: opts.includeContent });
    errors.push(...result.errors);
    notes.push(...result.notes);
    return result.files;
  } catch (err) {
    errors.push({ layer: 'transcripts', error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Wraps the sync buffer collector — it has no error channel of its own (collect-buffers.ts:60-65). */
function collectBuffersSafe(
  opts: BuildBundleOptions,
  window: DiagnosticWindow,
  errors: CollectorError[],
  notes: string[],
): BundleFile[] {
  try {
    const result = collectBuffers({
      groveId: opts.groveId,
      mycoHome: opts.mycoHome,
      sessionIdsInWindow: sessionIdsInWindow(opts.db, window),
      includeContent: opts.includeContent,
    });
    notes.push(...result.notes);
    return result.files;
  } catch (err) {
    errors.push({ layer: 'buffers', error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Keep the newest `keep` bundles for this Grove in `outDir`; delete the rest. Best-effort. */
function sweepRetention(outDir: string, safeGroveId: string, keep = 5): void {
  const prefix = `myco-diagnostic-${safeGroveId}-`;
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.zip'))
    .map((name) => {
      const full = path.join(outDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        // Vanished between readdir and stat (a concurrent export/sweep raced
        // us) — sorts as oldest, harmless either way.
      }
      return { full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of candidates.slice(keep)) {
    try {
      unlinkSync(stale.full);
    } catch {
      // Best-effort: another process may have already removed it.
    }
  }
}

/**
 * Build a diagnostic export bundle: the integration point for every
 * collector. A per-collector try/catch means one broken layer (a missing
 * doctor dependency, an unreadable audit db) never blocks the rest — the
 * bundle always builds, and failures land in `manifest.collector_errors`
 * instead. `setImmediate` yields between collectors so a slow doctor/audit
 * pass never wedges the daemon's main loop (the established pattern —
 * backup CREATE also runs in-process, backup.ts:109-127).
 */
export async function buildDiagnosticBundle(
  opts: BuildBundleOptions,
): Promise<{ filePath: string; sizeBytes: number; manifest: BundleManifest }> {
  const window = resolveWindow(opts.db, opts.window);

  const sessionCount = countSessionsInWindow(opts.db, window);
  const logEntryCount = countLogEntriesInWindow(opts.db, window);
  if (sessionCount === 0 && logEntryCount === 0) {
    throw new EmptyWindowError(nearestSessions(opts.db, window));
  }

  const files: BundleFile[] = [];
  const errors: CollectorError[] = [];
  const notes: string[] = [];

  const run = async (layer: string, fn: () => string | Promise<string>): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      files.push({ path: layerFileName(layer), data: await fn() });
    } catch (err) {
      errors.push({ layer, error: err instanceof Error ? err.message : String(err) });
    }
  };

  await run('environment', () =>
    collectEnvironment({ config: opts.config, mycoVersion: opts.mycoVersion, schemaVersion: SCHEMA_VERSION }),
  );
  await run('doctor', () => collectDoctor(opts.vaultDir));
  await run('audit', () => collectAudit({ dbPath: opts.dbPath, since: window.since }));
  await run('sessions', () => collectSessionRows(opts.db, window, opts.includeContent));
  await run('agent-runs', () => collectAgentRuns(opts.db, window, opts.includeContent));
  await run('log-entries', () => collectLogEntries(opts.db, window, opts.includeContent));
  // daemon-log NEVER honors includeContent — see collectDaemonLog above.
  await run('daemon-log', () => collectDaemonLog(opts.logDir, window));

  const transcriptFiles = await collectTranscriptsSafe(opts, window, errors, notes);
  files.push(...transcriptFiles);
  const bufferFiles = collectBuffersSafe(opts, window, errors, notes);
  files.push(...bufferFiles);

  if (opts.narrative?.trim()) {
    files.push({ path: 'narrative.md', data: opts.narrative.trim() + '\n' });
  }

  const manifest: BundleManifest = {
    bundle_format: 1,
    myco_version: opts.mycoVersion,
    schema_version: SCHEMA_VERSION,
    platform: `${os.platform()}-${os.arch()}`,
    grove_id: opts.groveId,
    window,
    include_content: opts.includeContent,
    generated_at: Math.floor(Date.now() / 1000),
    files: [...files.map((f) => f.path), 'manifest.json'],
    collector_errors: errors,
    notes,
    doctor_vault_dir: opts.vaultDir,
  };
  files.unshift({ path: 'manifest.json', data: JSON.stringify(manifest, null, 2) });

  const zipped = createZip(files);

  const outDir = resolveDiagnosticsRoot(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const safeGroveId = safePathSegment(opts.groveId).segment;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outDir, `myco-diagnostic-${safeGroveId}-${timestamp}.zip`);
  writeFileSync(filePath, zipped);

  sweepRetention(outDir, safeGroveId);

  return { filePath, sizeBytes: zipped.byteLength, manifest };
}
