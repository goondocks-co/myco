/**
 * Observability side-channel for the DETACHED adopt orchestrator.
 *
 * The orchestrator (`runAdopt` in orchestrator.ts) runs as a separate
 * `stdio:'ignore'` process spawned just before the daemon exits, so it has no
 * structured logger and no handle on the grove DB it is restarting. Its restart
 * attempts, health-watch results, and rollback decisions otherwise vanish into
 * /dev/null — which is exactly why adopt failures were undebuggable.
 *
 * Instead it APPENDS structured events here, and the daemon DRAINS them on its
 * next startup (see the restart-reason ingestion in daemon/main.ts), replaying
 * each through the logger under {@link LOG_KINDS.UPGRADE_ADOPT} so the whole
 * sequence lands in `log_entries` and the log viewer. Mirrors the existing
 * restart-reason.json → daemon.version_sync pattern rather than inventing a
 * bespoke, viewer-invisible log file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { UPDATE_EVENTS_PATH } from '../constants/update.js';

export type UpdateEventLevel = 'info' | 'warn' | 'error';

export interface UpdateEvent {
  /** ISO timestamp recorded by the orchestrator at emit time. */
  ts: string;
  level: UpdateEventLevel;
  message: string;
  /** Structured metadata (versions, attempt counts, the version health saw). */
  data?: Record<string, unknown>;
}

/**
 * Append one adopt event. Best-effort and NEVER throws: observability must not
 * be able to break the self-upgrade it is observing. `eventsPath` is injectable
 * so the orchestrator can point it at a hermetic location under test instead of
 * the machine-global default.
 */
export function appendUpdateEvent(
  eventsPath: string,
  level: UpdateEventLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, data }) + '\n';
    fs.appendFileSync(eventsPath, line);
  } catch {
    /* best-effort */
  }
}

/**
 * Read and DELETE the event log, returning the parsed events in order. Malformed
 * lines are skipped (never let a corrupt side-channel wedge startup). Returns []
 * when the file is absent or unreadable.
 */
export function drainUpdateEvents(eventsPath: string = UPDATE_EVENTS_PATH): UpdateEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsPath, 'utf-8');
  } catch {
    return []; // ENOENT (the common case) or unreadable
  }
  try { fs.unlinkSync(eventsPath); } catch { /* best-effort */ }

  const events: UpdateEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<UpdateEvent>;
      if (typeof parsed.message !== 'string') continue;
      events.push({
        ts: typeof parsed.ts === 'string' ? parsed.ts : new Date().toISOString(),
        level: parsed.level === 'warn' || parsed.level === 'error' ? parsed.level : 'info',
        message: parsed.message,
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : undefined,
      });
    } catch {
      /* skip a malformed line */
    }
  }
  return events;
}
