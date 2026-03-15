import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry } from '../daemon/logger.js';
import { LEVEL_ORDER } from '../daemon/logger.js';
import type { LogLevel } from '../daemon/logger.js';

export { LEVEL_ORDER };
export type { LogEntry, LogLevel };

export interface LogQuery {
  limit?: number;
  level?: LogLevel;
  component?: string;
  since?: string;
  until?: string;
}

export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  truncated: boolean;
}

/** Default number of entries returned when no limit is specified. */
export const DEFAULT_LOG_TAIL = 50;

/** Hard ceiling on entries returned to prevent memory issues. */
const MAX_LOG_QUERY_LIMIT = 10_000;

/** Matches daemon.log, rotated daemon.N.log, and mcp.jsonl. */
const DAEMON_LOG_PATTERN = /^daemon(?:\.(\d+))?\.log$/;
const MCP_LOG_FILE = 'mcp.jsonl';

/**
 * Query parsed log entries from all JSONL log files on disk.
 * Reads both daemon logs and MCP activity logs.
 * Returns the last N matching entries (tail behavior).
 */
export function queryLogs(logDir: string, query: LogQuery = {}): LogQueryResult {
  const limit = Math.min(query.limit ?? DEFAULT_LOG_TAIL, MAX_LOG_QUERY_LIMIT);

  const logFiles = discoverLogFiles(logDir);
  if (logFiles.length === 0) {
    return { entries: [], total: 0, truncated: false };
  }
  const allEntries = readAndParse(logFiles);

  // Sort all entries by timestamp so daemon + MCP logs interleave correctly
  allEntries.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

  const filtered = applyFilters(allEntries, query);

  const total = filtered.length;
  const truncated = total > limit;
  const entries = truncated ? filtered.slice(total - limit) : filtered;

  return { entries, total, truncated };
}

/** Discover and sort log files: MCP first, then rotated daemon logs oldest-first, current daemon last. */
function discoverLogFiles(logDir: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(logDir);
  } catch {
    return [];
  }

  const matched: Array<{ path: string; order: number }> = [];
  for (const file of files) {
    if (file === MCP_LOG_FILE) {
      matched.push({ path: path.join(logDir, file), order: -1 });
      continue;
    }
    const m = DAEMON_LOG_PATTERN.exec(file);
    if (!m) continue;
    const rotationNum = m[1] ? parseInt(m[1], 10) : 0;
    matched.push({ path: path.join(logDir, file), order: rotationNum });
  }

  matched.sort((a, b) => {
    if (a.order === 0) return 1;
    if (b.order === 0) return -1;
    return b.order - a.order;
  });

  return matched.map((m) => m.path);
}

/** Read all log files and parse each line as JSON. Malformed lines are skipped. */
function readAndParse(filePaths: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const filePath of filePaths) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        // Malformed line — skip
      }
    }
  }
  return entries;
}

/** Test whether a single entry matches the query filters. */
export function matchesFilter(entry: LogEntry, query: LogQuery): boolean {
  if (query.level) {
    const entryOrder = LEVEL_ORDER[entry.level as LogLevel] ?? 0;
    const minOrder = LEVEL_ORDER[query.level];
    if (entryOrder < minOrder) return false;
  }
  if (query.component && entry.component !== query.component) return false;
  if (query.since && entry.timestamp < query.since) return false;
  if (query.until && entry.timestamp > query.until) return false;
  return true;
}

/** Apply level, component, and time range filters. */
function applyFilters(entries: LogEntry[], query: LogQuery): LogEntry[] {
  return entries.filter((entry) => matchesFilter(entry, query));
}
