/**
 * A worker's log line, stamped with the instant it was written.
 *
 * Two workers on two machines report on the same runs, and the Deployment
 * records those runs by the instant. A line without one cannot be lined up with
 * the other machine's log or with the run record.
 */
export function workerLogLine(line: string, now: number = Date.now()): string {
  return `${new Date(now).toISOString()} worker: ${line}`;
}
