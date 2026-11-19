/** When a session with no end counts as quiet: the idle close titling and every session read share. */
import type { ServerEnv } from './adapters.js';
import { TITLING_IDLE_CLOSE_MINUTES_DEFAULT } from '../constants.js';
import { storedSettings } from './settings.js';

const MINUTE_MS = 60_000;

/** The leaf holding how long a session still open may be quiet before it counts as ended for titling. */
const IDLE_CLOSE_LEAF = 'agent.titling_idle_close_minutes';

/** Minutes without activity after which a session still open counts as ended for titling; unset, or a stored value the leaf's rule refuses, means the default. */
export async function titlingIdleCloseMinutes(env: Pick<ServerEnv, 'db'>): Promise<number> {
  const held = (await storedSettings(env.db, [IDLE_CLOSE_LEAF])).get(IDLE_CLOSE_LEAF);
  return held !== undefined && held.violation === null ? held.value as number : TITLING_IDLE_CLOSE_MINUTES_DEFAULT;
}

/**
 * The instant a session with no end must have been heard from after to be live at `now`: one quiet since then has gone
 * idle for `agent.titling_idle_close_minutes`, counts as ended for titling, and reads as live nowhere.
 */
export async function sessionQuietBefore(env: Pick<ServerEnv, 'db'>, now: number): Promise<number> {
  return now - (await titlingIdleCloseMinutes(env)) * MINUTE_MS;
}
