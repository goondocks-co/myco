import type { LogEntry, LogLevel } from './logger.js';
import { LEVEL_ORDER } from './logger.js';

const LOG_RING_BUFFER_CAPACITY = 1000;
const LOG_QUERY_DEFAULT_LIMIT = 100;

interface LogQueryResult {
  entries: LogEntry[];
  cursor: string;
  cursor_reset?: boolean;
}

interface LogQueryOptions {
  level?: LogLevel;
  limit?: number;
}

export class LogRingBuffer {
  private buffer: LogEntry[];
  private head = 0;
  private count = 0;
  private sequence = 0;
  private startSequence = 0;
  private readonly capacity: number;

  constructor(capacity = LOG_RING_BUFFER_CAPACITY) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.startSequence++;
    }
    this.sequence++;
  }

  since(cursor: string | null, options?: LogQueryOptions): LogQueryResult {
    const limit = options?.limit ?? LOG_QUERY_DEFAULT_LIMIT;
    const minLevel = options?.level ? LEVEL_ORDER[options.level] : 0;

    let startIdx = 0;
    let cursorReset = false;

    if (cursor !== null) {
      const seq = parseInt(cursor, 10);
      if (isNaN(seq) || seq < this.startSequence) {
        cursorReset = true;
        startIdx = 0;
      } else {
        startIdx = seq - this.startSequence;
      }
    } else {
      // No cursor: return last `limit` entries
      startIdx = Math.max(0, this.count - limit);
    }

    const entries: LogEntry[] = [];
    for (let i = startIdx; i < this.count && entries.length < limit; i++) {
      const bufIdx = (this.head - this.count + i + this.capacity) % this.capacity;
      const entry = this.buffer[bufIdx];
      if (entry && LEVEL_ORDER[entry.level as LogLevel] >= minLevel) {
        entries.push(entry);
      }
    }

    const result: LogQueryResult = {
      entries,
      cursor: String(this.sequence),
    };
    if (cursorReset) result.cursor_reset = true;
    return result;
  }
}
