/**
 * The shipped Worker with the two bindings local `wrangler dev` cannot simulate supplied as stand-ins, for a scenario
 * that dispatches the embedding pass: the Deployment prepares it only where an index and an embedding model are bound.
 *
 * - `AI` refuses every call: the recording launch starts no embedding run, so nothing asks it for a vector.
 * - `VECTORIZE` is the exact-cosine Vectorize stand-in the embedding tests prove the adapter against
 *   (`tests/myco-server/helpers/vector-index.ts`).
 *
 * Nothing here is part of the deployed bundle: only a parity boot names this file as `main`.
 */
import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import type { EmbeddingBinding } from '../../../packages/myco-server/src/platform/cloudflare/embedding.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';

const vectorize = indexFixture();
const ai: EmbeddingBinding = {
  async run() { throw new Error('the parity embedding binding embeds nothing: a recording launch starts no embedding run'); },
};

export { DeploymentClock, RecoveryProducer };

export default {
  fetch: (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    worker.fetch(request, { ...bindings, AI: ai, VECTORIZE: vectorize }, deferred),
  scheduled: worker.scheduled,
};
