import fs from 'node:fs';
import path from 'node:path';

export interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('debug', component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('info', component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('warn', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.write('error', component, message, data);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  private write(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...data,
    };

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
