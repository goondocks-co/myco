import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';

const fingerprints = read<[project: string, session: string, generation: number, turns: string], { turn: string; hash: string | null; bytes: number | null }>({
  name: 'turnFingerprint.priors', sql: `SELECT prompt_id AS turn,input_hash AS hash,source_bytes AS bytes FROM session_prompts
    WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND prompt_id IN (SELECT value FROM json_each(?4))`,
});

export const priorTurnFingerprints = (db: RelationalStore, key: readonly [string, string, number], turns: readonly string[]) =>
  rows(db, fingerprints.bind(...key, JSON.stringify(turns)));
