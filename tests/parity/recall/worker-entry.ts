/**
 * The shipped Worker, for the recall eval only: the same handler and Durable
 * Objects, with the two bindings local `wrangler dev` cannot simulate supplied
 * from the frozen fixture.
 *
 * - `AI` answers `@cf/baai/bge-m3` from the production vectors the fixture
 *   froze, through the shipped `cloudflareEmbeddingProvider`.
 * - `VECTORIZE` is the exact-cosine Vectorize stand-in the embedding tests
 *   already prove the adapter against (`tests/myco-server/helpers/vector-index.ts`),
 *   behind the shipped `cloudflareVectorStore`.
 *
 * D1, workerd, the pipeline, ranking, calibration and the injection budget are
 * the shipped code. Nothing here is part of the deployed bundle: only the
 * eval's own parity boot names this file as `main`.
 */
import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { EMBEDDING_MODEL, type EmbeddingBinding } from '../../../packages/myco-server/src/platform/cloudflare/embedding.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';
import { fixtureLookup, type VectorIndexFile } from './lookup.ts';
import vectorIndex from '../../fixtures/evals/recall/vectors.json';
import vectorData from '../../fixtures/evals/recall/vectors.bin';

const lookup = fixtureLookup(vectorIndex as VectorIndexFile, vectorData);
/** One index for the isolate's life: the eval seeds, calibrates and queries inside one `wrangler dev` session. */
const vectorize = indexFixture();
const ai: EmbeddingBinding = {
  async run(model, input) {
    if (model !== EMBEDDING_MODEL) throw new Error(`the recall fixture holds ${EMBEDDING_MODEL} vectors, not ${String(model)}`);
    const [text] = input.text;
    if (text === undefined) throw new Error('an embedding request carried no text');
    return { data: [await lookup.vectorFor(text)] };
  },
};

export { DeploymentClock, RecoveryProducer };

export default {
  fetch: (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    worker.fetch(request, { ...bindings, AI: ai, VECTORIZE: vectorize }, deferred),
  scheduled: worker.scheduled,
};
