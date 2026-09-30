/** Stops the launcher the global setup started, and only that process. */
import { SCREENS_ENV } from './env.ts';

export default async function globalTeardown(): Promise<void> {
  const pid = Number(process.env[SCREENS_ENV.pid]);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* it exited between the probe and the kill */ }
}
