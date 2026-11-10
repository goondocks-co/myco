/**
 * The active spores closest to one just saved, as a learning run needs them to curate: each with what supersede and
 * consolidate ask for, so the run acts in the same pass without a counted full read.
 *
 * Semantic neighbours come first where the Deployment has a provider. A word search over the Project's newest active
 * spores sharing the line's words fills the rest, and it alone sees a spore saved moments ago, which has no vector yet.
 */
import type { ServerEnv } from './adapters.js';
import { embedding_semanticSearch as semanticSearch } from '../read/catalog/embedding.js';
import type { ReadScope } from '../read/scope.js';
import { resolveSemanticSearch, sporesSharingWords } from './search.js';
import { SPORE_PREVIEW_CHARS } from './spores.js';
import { listSporesByIds } from '../db/spores/records.js';

/** The neighbours one save answers with. */
const NEAR_MATCH_LIMIT = 5;
/** The newest matching spores a word search ranks. */
const NEAR_MATCH_WINDOW = 100;
/** The longest words of a spore's line a word search reads. */
const MATCH_WORDS = 8;
/** Words shorter than this name nothing a neighbour would share. */
const MATCH_WORD_MIN_CHARS = 4;

/** One neighbour: enough to supersede it or consolidate it, and to judge whether to. */
interface NearMatch { id: string; revision: number; observation_type: string; agent_line: string }

async function semanticNeighbours(env: ServerEnv, scope: ReadScope, line: string): Promise<string[]> {
  try {
    const semantic = await resolveSemanticSearch(env);
    if (semantic === null) return [];
    return (await semanticSearch(env.db, scope, semantic, ['spore'], { query: line, status: 'active' }, NEAR_MATCH_LIMIT + 1)).map((hit) => hit.id);
  } catch { return []; }
}

/** The line's longest words, which name what it is about. */
function matchWords(line: string): string[] {
  return [...new Set(line.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length >= MATCH_WORD_MIN_CHARS)
    .sort((a, b) => b.length - a.length).slice(0, MATCH_WORDS);
}

/** The closest active spores to a saved one, closest first. A failure reads as no neighbours: the spore has landed, and its id must still reach the run. */
export async function nearSpores(env: ServerEnv, scope: ReadScope, savedId: string, line: string): Promise<NearMatch[]> {
  try {
    const close = (await semanticNeighbours(env, scope, line)).filter((id) => id !== savedId);
    const words = close.length < NEAR_MATCH_LIMIT
      ? (await sporesSharingWords(env, scope, matchWords(line), { limit: NEAR_MATCH_LIMIT + 1, window: NEAR_MATCH_WINDOW })).filter((id) => id !== savedId)
      : [];
    const ids = [...new Set([...close, ...words])].slice(0, NEAR_MATCH_LIMIT);
    const rows = new Map((await listSporesByIds(env.db, scope, ids)).map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = rows.get(id);
      if (row === undefined || row.status !== 'active') return [];
      return [{ id, revision: row.revision, observation_type: row.observationType,
        agent_line: row.agentLine ?? row.content.replace(/\s+/g, ' ').trim().slice(0, SPORE_PREVIEW_CHARS) }];
    });
  } catch { return []; }
}
