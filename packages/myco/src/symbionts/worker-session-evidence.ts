import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock, withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { HARNESS_ACTIVITY_RETENTION_MS } from '@goondocks/myco-shared/harness-health';

/** Durable worker session identities, independent of run-directory cleanup and concurrent worker processes. */
export class WorkerSessionEvidence {
  constructor(private readonly mycoHome: string) {}

  /** Hold admission until the harness has returned a session identity that can be excluded. */
  begin(harness: string): () => void {
    const acquired = LifecycleLock.acquire(this.startupFile(harness), { command: 'myco worker session admission', mode: 'shared', wait: true });
    if (!acquired.acquired) throw new Error('Worker session admission is busy');
    try { atomicWriteFileSync(`${this.startupFile(harness)}.epoch`, crypto.randomUUID(), { mode: 0o600, durable: true }); } catch (error) {
      acquired.lock.release();
      throw error;
    }
    return () => acquired.lock.release();
  }

  /** Detect any worker admission overlapping a read, including one that finishes during the read. */
  epoch(harness: string): string {
    try { return fs.readFileSync(`${this.startupFile(harness)}.epoch`, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  starting(harness: string): boolean {
    const acquired = LifecycleLock.acquire(this.startupFile(harness), { command: 'myco worker session admission check' });
    if (!acquired.acquired) return true;
    acquired.lock.release();
    return false;
  }

  private startupFile(harness: string): string {
    const key = crypto.createHash('sha256').update(harness).digest('hex');
    return path.join(this.mycoHome, 'member', `worker-starting-${key}.lock`);
  }

  private file(harness: string, sessionId: string): string {
    const key = crypto.createHash('sha256').update(JSON.stringify([harness, sessionId])).digest('hex');
    return path.join(this.mycoHome, 'member', 'worker-sessions', key);
  }

  record(harness: string, sessionId: string): void {
    this.write(() => {
      const file = this.file(harness, sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(file, 'worker\n', { mode: 0o600, durable: true });
    });
  }

  /** Retain exclusions for the same window as the session evidence they exclude. */
  prune(now: number): void {
    this.write(() => {
      const dir = path.dirname(this.file('', ''));
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}$/.test(entry)) continue;
        const file = path.join(dir, entry);
        try {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && stat.mtimeMs < now - HARNESS_ACTIVITY_RETENTION_MS) fs.unlinkSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }, true);
  }

  private write(fn: () => void, maintenance = false): void {
    const lock = path.join(this.mycoHome, 'member', 'worker-sessions.lock');
    if (!maintenance) return withFileLockSync(lock, fn);
    const acquired = LifecycleLock.acquire(lock, { command: 'myco worker session evidence' });
    if (!acquired.acquired) {
      if (maintenance) return;
      throw new Error('Worker session evidence is busy');
    }
    try { fn(); } finally { acquired.lock.release(); }
  }

  has(harness: string, sessionId: string): boolean {
    try { fs.statSync(this.file(harness, sessionId)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
