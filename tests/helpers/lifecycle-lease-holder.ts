/**
 * One lease holder in its own process, for the cross-process parts of the lock contract: a lease the kernel releases
 * when this process dies, and one another process must be refused while this one holds it.
 *
 * Usage: bun tests/helpers/lifecycle-lease-holder.ts <lockPath> <exclusive|shared> <heldMarker> <stopMarker>
 */
import fs from 'node:fs';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

const [lockPath, mode, heldMarker, stopMarker] = process.argv.slice(2) as [string, 'exclusive' | 'shared', string, string];
const held = LifecycleLock.acquire(lockPath, { command: 'lifecycle lease holder', mode });
fs.writeFileSync(heldMarker, JSON.stringify({ acquired: held.acquired, pid: process.pid }));
if (!held.acquired) process.exit(1);
const until = Date.now() + 60_000;
while (!fs.existsSync(stopMarker) && Date.now() < until) await Bun.sleep(20);
held.lock.release();
process.exit(0);
