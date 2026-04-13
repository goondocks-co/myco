import { queryLogs, matchesFilter, DEFAULT_LOG_TAIL, LEVEL_ORDER } from '../logs/reader.js';
import type { LogEntry, LogLevel } from '../logs/reader.js';
import { formatLogLine, parseIntFlag, parseStringFlag } from '../logs/format.js';
import fs from 'node:fs';
import path from 'node:path';

/** Polling interval for follow mode (milliseconds). */
const FOLLOW_POLL_INTERVAL_MS = 500;

export function run(args: string[], vaultDir: string): void {
  const logDir = path.join(vaultDir, 'logs');
  const follow = args.includes('--follow') || args.includes('-f');
  const limit = parseIntFlag(args, '--tail', '-n') ?? DEFAULT_LOG_TAIL;
  const rawLevel = parseStringFlag(args, '--level', '-l');
  if (rawLevel && !(rawLevel in LEVEL_ORDER)) {
    console.error(`Invalid level: ${rawLevel}. Valid levels: ${Object.keys(LEVEL_ORDER).join(', ')}`);
    process.exit(1);
  }
  const level = rawLevel as LogLevel | undefined;
  const component = parseStringFlag(args, '--component', '-c');
  const since = parseStringFlag(args, '--since');
  const until = parseStringFlag(args, '--until');

  // Show initial tail
  const result = queryLogs(logDir, { limit, level, component, since, until });
  for (const e of result.entries) {
    process.stdout.write(formatLogLine(e) + '\n');
  }
  if (result.truncated) {
    process.stdout.write(`  ... ${result.total - result.entries.length} earlier entries omitted\n`);
  }

  if (!follow) return;

  // Follow mode: watch for new appends via stat-based polling.
  // --since is intentionally not applied to streamed lines (only the initial tail).
  const followFilter = { level, component, until };
  const logPath = path.join(logDir, 'daemon.log');
  let offset = 0;
  try {
    offset = fs.statSync(logPath).size;
  } catch {
    // File doesn't exist yet — start from 0
  }

  fs.watchFile(logPath, { interval: FOLLOW_POLL_INTERVAL_MS }, (curr, prev) => {
    if (curr.size < prev.size || curr.ino !== prev.ino) {
      // Rotation detected — reset to beginning of new file
      offset = 0;
    }
    if (curr.size <= offset) return;

    try {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(curr.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);

      const text = buf.toString('utf-8');
      // Only advance offset past complete lines to avoid losing partial writes
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return; // no complete lines yet
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1));

      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as LogEntry;
          if (!matchesFilter(e, followFilter)) continue;
          process.stdout.write(formatLogLine(e) + '\n');
        } catch {
          // Malformed line
        }
      }
    } catch {
      // File read error — skip this cycle
    }
  });

  // fs.watchFile with persistent: true (default) keeps the event loop alive.
  // SIGINT (Ctrl+C) cleans up the watcher.
  process.on('SIGINT', () => {
    fs.unwatchFile(logPath);
    process.exit(0);
  });
}
