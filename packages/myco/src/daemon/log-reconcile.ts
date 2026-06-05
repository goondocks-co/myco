import fs from 'node:fs';
import path from 'node:path';
import { insertLogEntry } from '@myco/db/queries/logs.js';
import { logEntryToInsert } from './log-entry-insert.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

/**
 * Replay JSONL log entries that are newer than the last entry in SQLite.
 * Returns the number of entries replayed.
 */
export function reconcileLogBuffer(
  logDir: string,
  sinceTimestamp: string,
  fallbackProjectId: GroveProjectId | null,
): number {
  let replayed = 0;

  // Read log files in order: rotated files first (oldest), then current
  const files: string[] = [];
  for (let i = 3; i >= 1; i--) {
    const rotated = path.join(logDir, `daemon.${i}.log`);
    if (fs.existsSync(rotated)) files.push(rotated);
  }
  const current = path.join(logDir, 'daemon.log');
  if (fs.existsSync(current)) files.push(current);

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp > sinceTimestamp) {
          insertLogEntry(logEntryToInsert(entry, fallbackProjectId));
          replayed++;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return replayed;
}
