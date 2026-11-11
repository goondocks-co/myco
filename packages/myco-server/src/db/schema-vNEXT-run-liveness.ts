import { LAST_PULLED_WAITING } from './schema-vNEXT-pulled-waiting.js';

/** Placeholder step of this change; the coordinator assigns the real number at merge. */
export const NEXT_RUN_LIVENESS = LAST_PULLED_WAITING + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_RUN_LIVENESS = NEXT_RUN_LIVENESS;
