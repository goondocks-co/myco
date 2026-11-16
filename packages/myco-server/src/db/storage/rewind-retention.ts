import { D1_REWIND_RETENTION_MS } from '../../constants.js';

/** The later of the rewind hold and a failed delete's next attempt. */
export const retainedReleaseDue = `MAX(created_at+${D1_REWIND_RETENTION_MS},retry_at)`;
