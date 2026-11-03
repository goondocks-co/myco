import { DISPATCH_ACTOR_SQL } from './run-context.js';
/** An unchanged input advances the schedule interval without spending its daily allowance. */
export const INPUT_UNCHANGED = 'input_unchanged';
export const SCHEDULE_ENTRY_SQL = `(status != 'skipped' OR (status = 'skipped' AND run_context = '${JSON.stringify({ reason: INPUT_UNCHANGED })}'))`;

export const SCHEDULE_ACTOR_SQL = `COALESCE(${DISPATCH_ACTOR_SQL}, '')`;
