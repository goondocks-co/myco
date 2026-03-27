import fs from 'node:fs';
import path from 'node:path';
import { insertLogEntry } from '@myco/db/queries/logs.js';
import { kindToComponent } from '@myco/constants/log-kinds.js';

/**
 * Replay JSONL log entries that are newer than the last entry in SQLite.
 * Returns the number of entries replayed.
 */
export function reconcileLogBuffer(logDir: string, sinceTimestamp: string): number {
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
          const { timestamp, level, kind, component, message, ...rest } = entry;
          insertLogEntry({
            timestamp,
            level,
            kind: kind ?? `${component ?? 'unknown'}.unknown`,
            component: component ?? kindToComponent(kind ?? 'unknown'),
            message,
            data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
            session_id: rest.session_id ?? null,
          });
          replayed++;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  return replayed;
}
