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

export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

interface LoggerOptions {
  level?: LogLevel;
  maxSize?: number;
  maxFiles?: number;
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

  constructor(logDir: string, options: LoggerOptions = {}) {
    this.logDir = logDir;
    this.logPath = path.join(logDir, 'daemon.log');
    this.level = options.level ?? 'info';
    this.maxSize = options.maxSize ?? 5_242_880;
    this.maxFiles = options.maxFiles ?? 3;

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
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private write(level: LogLevel, kind: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

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

    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line);

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
