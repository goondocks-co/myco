import { resolveMycoHome } from '@myco/paths/home.js';
import { WorkerSessionEvidence } from '@myco/symbionts/worker-session-evidence.js';
import type { Driver } from '../events.js';

/** Record a worker's session identity before any session event reaches its caller. */
export function withWorkerActivity(driver: Driver): Driver {
  return {
    ...driver,
    async *run(spec, signal) {
      const evidence = new WorkerSessionEvidence(resolveMycoHome());
      const recorded = new Set<string>();
      const record = (sessionId: string): void => {
        if (recorded.has(sessionId)) return;
        evidence.record(driver.id, sessionId);
        recorded.add(sessionId);
      };
      for await (const event of driver.run({ ...spec, sessionOpened: record }, signal)) {
        if (event.kind === 'started' && event.sessionId !== null) record(event.sessionId);
        yield event;
      }
    },
  };
}
