import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';

/** Durable worker session identities, independent of run-directory cleanup and concurrent worker processes. */
export class WorkerSessionEvidence {
  constructor(private readonly mycoHome: string) {}

  private file(harness: string, sessionId: string): string {
    const key = crypto.createHash('sha256').update(JSON.stringify([harness, sessionId])).digest('hex');
    return path.join(this.mycoHome, 'member', 'worker-sessions', key);
  }

  record(harness: string, sessionId: string): void {
    const file = this.file(harness, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(file, 'worker\n', { mode: 0o600, durable: true });
  }

  has(harness: string, sessionId: string): boolean {
    try { fs.statSync(this.file(harness, sessionId)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}
