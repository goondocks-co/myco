import type { RelationalStore } from './adapters.js';
import { ensureAgent, getState, mutateState } from './runs.js';
import { HARNESS_AGENT_ID } from './harness.js';
import { emit } from '../telemetry.js';

/** State keys owned by the server; run tools cannot write them. */
export const SERVER_STATE_PREFIX = 'server.';
export const schedulerStateKey = (key: string): string => `${SERVER_STATE_PREFIX}schedule.${key}`;

/** Typed scheduler control state; invalid stored values reset with a telemetry event. */
export function schedulerState<T>(db: RelationalStore, projectId: string, key: string, valid: (value: unknown) => value is T, now: number) {
  const storedKey = schedulerStateKey(key);
  const invalid = new Set<string>();
  const parse = (text: string | null): T | null => {
    if (text === null) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (valid(value)) return value;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (!invalid.has(text)) {
      invalid.add(text);
      emit({ kind: 'schedule_state_reset', projectId, key: storedKey });
    }
    return null;
  };
  return {
    async read(): Promise<{ value: T | null; reset: boolean }> {
      const text = (await getState(db, { projectId }, HARNESS_AGENT_ID, storedKey))?.value ?? null;
      const value = parse(text);
      return { value, reset: text !== null && value === null };
    },
    async update(change: (current: T | null) => T): Promise<void> {
      await ensureAgent(db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, now);
      const stored = await mutateState(db, { projectId }, HARNESS_AGENT_ID, storedKey, current => {
        const next = JSON.stringify(change(parse(current)));
        return next === current ? null : next;
      }, now);
      if (!stored) throw new Error('Scheduler state contention');
    },
  };
}
