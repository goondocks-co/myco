/** The task the Deployment's in-process embedding run serves. */
export const EMBEDDING_TASK = 'embedding-reconcile';

/** How long a failed embedding run waits before the next is admitted. */
export const EMBEDDING_RETRY_MS = 60_000;
