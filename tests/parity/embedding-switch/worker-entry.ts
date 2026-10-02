/**
 * The shipped Worker, for the embedding switch scenario only: the same handler and Durable Objects, with a Workers AI
 * binding that answers every catalogued model with a vector of that model's size, and the exact-cosine Vectorize
 * stand-in the embedding tests already prove the adapter against (`tests/myco-server/helpers/vector-index.ts`).
 *
 * D1, workerd, the pipeline, the embedding step and the switch are the shipped code. Nothing here is part of the
 * deployed bundle: only this scenario's parity boot names this file as `main`.
 */
import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import type { EmbeddingBinding } from '../../../packages/myco-server/src/platform/cloudflare/embedding.ts';
import { EMBEDDING_CATALOGUE } from '../../../packages/myco-shared/src/settings-contract.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';
import { switchVector } from './vectors.ts';

/** One index for the isolate's life: the scenario builds, switches and queries inside one `wrangler dev` session. */
const vectorize = indexFixture();
const ai: EmbeddingBinding = {
  async run(model, input) {
    const dimensions = EMBEDDING_CATALOGUE['workers-ai'].models.find((m) => m.id === model)?.dimensions;
    if (dimensions === undefined) throw new Error(`Workers AI does not offer ${String(model)}`);
    const [text] = input.text;
    if (text === undefined) throw new Error('an embedding request carried no text');
    return { data: [switchVector(text, dimensions)] };
  },
};

export { DeploymentClock, RecoveryProducer };

export default {
  fetch: (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    worker.fetch(request, { ...bindings, AI: ai, VECTORIZE: vectorize }, deferred),
  scheduled: worker.scheduled,
};
