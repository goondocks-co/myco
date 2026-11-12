import { LAST_RUN_DRIFT } from './schema-vNEXT-run-drift.js';

/** Placeholder step of this change; the coordinator assigns the real number at merge. */
export const NEXT_PUBLICATION_REOPEN = LAST_RUN_DRIFT + 1;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_PUBLICATION_REOPEN = NEXT_PUBLICATION_REOPEN;
