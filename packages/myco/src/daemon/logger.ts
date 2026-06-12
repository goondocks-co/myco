import fs from 'node:fs';
import path from 'node:path';
import { kindToComponent } from '@myco/constants/log-kinds.js';

export interface LogEntry {
  timestamp: string;
  level: string;
  kind: string;
  component: string;
  message: string;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogPersistFn = (entry: LogEntry) => void;

/**
 * Structural logger interface consumed by manager classes.
 * `DaemonLogger` is the concrete implementation, but managers accept any
 * object matching this shape so tests can substitute mocks.
 */
export interface Logger {
  debug(cat: string, msg: string, data?: Record<string, unknown>): void;
  info(cat: string, msg: string, data?: Record<string, unknown>): void;
  warn(cat: string, msg: string, data?: Record<string, unknown>): void;
  error(cat: string, msg: string, data?: Record<string, unknown>): void;
}

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

interface LoggerOptions {
  level?: LogLevel;
  maxSize?: number;
  maxFiles?: number;
  /** Injectable clock for the degraded-mode retry window (tests). */
  now?: () => number;
}

export class DaemonLogger {
  private logPath: string;
  private fd: number | null = null;
  private currentSize = 0;
  private level: LogLevel;
  private maxSize: number;
  private maxFiles: number;
  private logDir: string;
  private persistFn: LogPersistFn | null = null;
  private now: () => number;

  constructor(logDir: string, options: LoggerOptions = {}) {
    this.logDir = logDir;
    this.logPath = path.join(logDir, 'daemon.log');
    this.level = options.level ?? 'info';
    this.maxSize = options.maxSize ?? 5_242_880;
    this.maxFiles = options.maxFiles ?? 3;
    this.now = options.now ?? Date.now;

    fs.mkdirSync(logDir, { recursive: true });
    this.fd = fs.openSync(this.logPath, 'a');
    try {
      this.currentSize = fs.fstatSync(this.fd).size;
    } catch {
      this.currentSize = 0;
    }
  }

  setPersistFn(fn: LogPersistFn): void {
    this.persistFn = fn;
  }

  /**
   * Change the active log level at runtime. Subsequent writes use the new
   * threshold immediately — no restart required. Used by the
   * daemon.log_level config reaction.
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', kind, message, data);
  }

  info(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', kind, message, data);
  }

  warn(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', kind, message, data);
  }

  error(kind: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', kind, message, data);
  }

  /** Dispatch a log entry by dynamic level string. */
  log(level: string, kind: string, message: string, data?: Record<string, unknown>): void {
    if (level in LEVEL_ORDER) {
      this.write(level as LogLevel, kind, message, data);
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // A close failure (already-invalid fd) must not propagate into
        // shutdown paths; the fd is abandoned either way.
      }
      this.fd = null;
    }
  }

  /**
   * The logger is the last-resort observability channel — it must NEVER
   * throw. Every log call runs through this guard: a sink failure (disk
   * full, revoked fd, rotation error) drops the line, emits ONE best-effort
   * stderr note, and enters degraded mode.
   *
   * Degraded mode counts dropped lines and re-attempts the full write pass
   * (reopen → rotate-if-needed → line) at most once per
   * RECOVERY_RETRY_INTERVAL_MS — a persistent failure (disk still full,
   * unrotatable dir) costs one syscall burst per window, not per call, and
   * cannot spam stderr or the file. Recovery is only DECLARED after a real
   * line has landed; the recovery note (with the dropped count) follows it,
   * and a failure anywhere in the pass — including the note itself — keeps
   * the cumulative count and degraded state intact.
   *
   * The CONSTRUCTOR deliberately stays fail-fast: a boot that cannot open
   * its log dir should exit loudly through the CLI's main().catch rather
   * than start a daemon nobody can observe.
   */
  private write(level: LogLevel, kind: string, message: string, data?: Record<string, unknown>): void {
    // Level filter FIRST: a below-threshold call must not interact with the
    // degraded-mode machinery at all (it lands nothing, so it can neither
    // count as dropped nor — critically — declare recovery).
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    try {
      if (this.degraded && this.now() < this.nextRecoveryAttemptAt) {
        this.droppedLines++;
        return;
      }
      this.writeUnsafe(level, kind, message, data);
      if (this.degraded) this.finishRecovery();
    } catch (err) {
      this.enterDegraded(err);
    }
  }

  private degraded = false;
  private droppedLines = 0;
  private nextRecoveryAttemptAt = 0;
  private static readonly RECOVERY_RETRY_INTERVAL_MS = 5_000;

  private enterDegraded(err: unknown): void {
    this.droppedLines++;
    this.nextRecoveryAttemptAt = this.now() + DaemonLogger.RECOVERY_RETRY_INTERVAL_MS;
    // Abandon the current fd: a sink failure may be a dead descriptor
    // (EBADF) rather than a full disk, and the retry re-opens from the
    // path, which handles both classes.
    this.close();
    if (!this.degraded) {
      this.degraded = true;
      try {
        process.stderr.write(`[myco logger] sink failure — dropping log lines until recovery: ${String(err)}\n`);
      } catch {
        // stderr unavailable too; nothing left to do
      }
    }
  }

  /**
   * Called only after a degraded-mode write pass fully succeeded (the
   * caller's line is on disk). Records the gap and clears the state; if the
   * note itself fails, the outer catch re-enters degraded mode with the
   * count preserved.
   */
  private finishRecovery(): void {
    const note = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'warn',
      kind: 'daemon.logger',
      component: 'daemon',
      message: 'Logger recovered from sink failure',
      dropped_lines: this.droppedLines,
    }) + '\n';
    if (this.fd !== null) {
      fs.writeSync(this.fd, note);
      this.currentSize += Buffer.byteLength(note);
    }
    this.degraded = false;
    this.droppedLines = 0;
    this.nextRecoveryAttemptAt = 0;
  }

  private writeUnsafe(level: LogLevel, kind: string, message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      kind,
      component: kindToComponent(kind),
      message,
      ...data,
    };

    if (this.persistFn !== null) {
      try {
        this.persistFn(entry);
      } catch {
        // File write is the safety net — persist failures are non-fatal
      }
    }

    // Metadata can carry circular structures or BigInts from arbitrary
    // callers; the entry must still land. Fall back to the throw-free core
    // fields with a marker rather than losing the line.
    let line: string;
    try {
      line = JSON.stringify(entry) + '\n';
    } catch {
      line = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        kind: entry.kind,
        component: entry.component,
        message: entry.message,
        metadata_unserializable: true,
      }) + '\n';
    }
    const bytes = Buffer.byteLength(line);

    if (this.fd === null) {
      // A deliberately closed logger (shutdown) drops late writes, as it
      // always has. A degraded one abandoned its fd on failure — re-open
      // from the path and re-sync size before the rotation check.
      if (!this.degraded) return;
      this.fd = fs.openSync(this.logPath, 'a');
      this.currentSize = fs.fstatSync(this.fd).size;
    }

    if (this.currentSize + bytes > this.maxSize) {
      this.rotate();
    }

    if (this.fd !== null) {
      fs.writeSync(this.fd, line);
      this.currentSize += bytes;
    }
  }

  private rotate(): void {
    this.close();

    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = path.join(this.logDir, `daemon.${i}.log`);
      const to = path.join(this.logDir, `daemon.${i + 1}.log`);
      if (fs.existsSync(from)) {
        if (i + 1 > this.maxFiles) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
      }
    }

    if (fs.existsSync(this.logPath)) {
      fs.renameSync(this.logPath, path.join(this.logDir, 'daemon.1.log'));
    }

    this.fd = fs.openSync(this.logPath, 'a');
    this.currentSize = 0;
  }
}
