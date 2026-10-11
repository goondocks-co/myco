import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const TASK_START_TIMEOUT_MS = 60_000;
const TASK_POLL_MS = 250;
export interface TaskSnapshot { state: string; lastRunTime: string; lastTaskResult: number }

export function readTaskProof<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function publishTaskProof(file: string, proof: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(proof), 'utf8');
  fs.renameSync(temporary, file);
}

/** Proof belongs to this start only after Task Scheduler reports a new running attempt. */
export async function waitForTaskProof<T>(
  snapshot: () => Promise<TaskSnapshot>, proof: () => T | undefined, previousRunTime: string,
  options: { now?: () => number; pause?: () => Promise<void>; timeoutMs?: number } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (() => sleep(TASK_POLL_MS));
  const deadline = now() + (options.timeoutMs ?? TASK_START_TIMEOUT_MS);
  let last: TaskSnapshot | undefined;
  while (now() < deadline) {
    last = await snapshot();
    if (last.lastRunTime !== previousRunTime) {
      if (last.state === 'Running') {
        const ready = proof();
        if (ready !== undefined) return ready;
      } else if (last.state !== 'Queued') {
        throw new Error(`Task Scheduler attempt stopped before proof: ${JSON.stringify(last)}`);
      }
    }
    await pause();
  }
  throw new Error(`Task Scheduler start timed out: ${JSON.stringify(last)}`);
}
