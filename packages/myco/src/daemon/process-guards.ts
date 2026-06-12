/**
 * Last-resort process guards for the daemon.
 *
 * Bun (like Node ≥15) exits code 1 on any unhandled promise rejection and
 * on any uncaught exception. For a daemon whose core contract is capture
 * availability and data preservation, an un-caught background failure must
 * never take the process down silently:
 *
 *  - `unhandledRejection` → log with stack and CONTINUE. Every DB write in
 *    the daemon is synchronous (bun:sqlite), so a rejected background
 *    promise cannot strand a half-open transaction — process death is
 *    strictly worse than continuing (in-flight captures dropped, launchd
 *    throttle gap, and lazily-spawned dev daemons have no supervisor at
 *    all). The log line (`daemon.unhandled_rejection`) is the signal that
 *    a fire-and-forget path is missing its own .catch.
 *
 *  - `uncaughtException` → log + best-effort stderr, then exit(1).
 *    A synchronous throw that escaped every handler leaves the process in
 *    unknown state; the OS service supervisor relaunches it and capture
 *    recovery covers the gap. Continuing would be guesswork.
 *
 * Installed at the very top of daemon main(), before any async work. The
 * logger does not exist yet at that point, so the guards take a getter and
 * fall back to stderr until it is bound (`bindLogger`).
 *
 * Daemon-only by design: the CLI keeps fail-loud defaults.
 */

import { LOG_KINDS } from '../constants/log-kinds.js';
import type { Logger } from './logger.js';

export interface ProcessGuardsHandle {
  /** Bind the real daemon logger once it exists. */
  bindLogger(logger: Logger): void;
  /** Remove the listeners (tests). */
  uninstall(): void;
}

interface GuardOptions {
  /** Injectable for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Injectable for tests; defaults to process.stderr.write. */
  stderr?: (line: string) => void;
}

function describe(reason: unknown): { message: string; stack: string | null } {
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack ?? null };
  }
  return { message: String(reason), stack: null };
}

export function installProcessGuards(options: GuardOptions = {}): ProcessGuardsHandle {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const writeStderr = options.stderr ?? ((line: string) => { process.stderr.write(line); });
  let logger: Logger | null = null;

  const emit = (kind: string, message: string, data: Record<string, unknown>): void => {
    // The logger's write path is never-throw, but the guard must survive
    // even a misbehaving Logger substitute — nothing here may propagate.
    try {
      if (logger) {
        logger.error(kind, message, data);
        return;
      }
    } catch {
      // fall through to stderr
    }
    try {
      writeStderr(`[myco daemon] ${message}: ${JSON.stringify(data)}\n`);
    } catch {
      // stderr unavailable; nothing left to do
    }
  };

  const onRejection = (reason: unknown): void => {
    const { message, stack } = describe(reason);
    emit(LOG_KINDS.DAEMON_UNHANDLED_REJECTION, 'Unhandled promise rejection — continuing', {
      reason: message,
      stack,
    });
  };

  const onException = (err: unknown): void => {
    const { message, stack } = describe(err);
    emit(LOG_KINDS.DAEMON_UNCAUGHT_EXCEPTION, 'Uncaught exception — exiting for supervisor relaunch', {
      reason: message,
      stack,
    });
    try {
      writeStderr(`[myco daemon] uncaught exception, exiting: ${message}\n`);
    } catch {
      // best-effort only
    }
    exit(1);
  };

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return {
    bindLogger(l: Logger): void {
      logger = l;
    },
    uninstall(): void {
      process.removeListener('unhandledRejection', onRejection);
      process.removeListener('uncaughtException', onException);
    },
  };
}
