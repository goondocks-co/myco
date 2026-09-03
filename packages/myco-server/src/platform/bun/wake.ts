/**
 * The self-hosted process's clock: the wake loop, bound to the tick.
 *
 * The entry point wires this in and out; what a wake does lives in the core.
 */
import type { ServerEnv } from '../../core/adapters.js';
import { runTick } from '../../core/tick.js';
import { startWakeLoop, WAKE_FLOOR_MS, type WakeLoop } from './wake-loop.js';

/** Start the loop for this env and hand it the wake port; `stop` ends it. */
export function startBunWake(env: ServerEnv): WakeLoop {
  const loop = startWakeLoop(() => runTick(env, Date.now()), { floorMs: WAKE_FLOOR_MS });
  env.wake = loop.ensure;
  return loop;
}
