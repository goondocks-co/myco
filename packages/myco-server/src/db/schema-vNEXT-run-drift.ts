import { LAST_RUN_LIVENESS } from './schema-vNEXT-run-liveness.js';

/** Placeholder step of this change; the coordinator assigns the real number at merge. */
export const NEXT_RUN_DRIFT = LAST_RUN_LIVENESS + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_RUN_DRIFT = NEXT_RUN_DRIFT;
