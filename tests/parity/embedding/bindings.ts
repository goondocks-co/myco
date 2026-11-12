import type { CloudflareBindings } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { EMBEDDING_CATALOGUE } from '../../../packages/myco-shared/src/settings-contract.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';
import { switchVector } from '../embedding-switch/vectors.ts';
import { fixtureLookup, type VectorIndexFile } from '../recall/lookup.ts';
import vectorIndex from '../../fixtures/evals/recall/vectors.json';
import vectorData from '../../fixtures/evals/recall/vectors.bin';
import { wordVector } from './word-vectors.ts';

export type EmbeddingFixture = 'constant' | 'words' | 'switch' | 'recall';

/** External embedding services supplied identically to the production HTTP entry and clock object. */
export function embeddingBindings(kind: EmbeddingFixture): Pick<CloudflareBindings, 'AI' | 'VECTORIZE'> {
  const lookup = kind === 'recall' ? fixtureLookup(vectorIndex as VectorIndexFile, vectorData) : undefined;
  return {
    VECTORIZE: indexFixture(),
    AI: { async run(model, input) {
      const dimensions = EMBEDDING_CATALOGUE['workers-ai'].models.find(row => row.id === model)?.dimensions;
      const [text] = input.text;
      if (dimensions === undefined || text === undefined || input.text.length !== 1) throw new Error('Unknown fixture embedding request');
      const values = kind === 'recall' ? await lookup!.vectorFor(text)
        : kind === 'switch' ? switchVector(text, dimensions)
        : kind === 'constant' ? [1, 0] : wordVector(text, dimensions);
      return { data: [values] };
    } },
  };
}
