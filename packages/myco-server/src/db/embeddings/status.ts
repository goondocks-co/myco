import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { hasSourcesToEmbed } from './work.js';
import { SOURCE_STATES, type SourceState } from './state.js';

/** Built and total current sources under a model, with whether those totals are complete as of `asOf`. */
export interface ModelTotals {
  state: 'ready' | 'building';
  /** Sources holding an indexed vector under the model. */
  ready: number;
  /** Every current source the model covers. */
  total: number;
  byState: Record<SourceState, number>;
  asOf: number;
}

const installed = read<[], { done: number }>({ name: 'embedding.stateInstalled',
  sql: "SELECT done FROM projection_catchup WHERE projection='embedding_state' AND phase='versions'" });
const projectModel = read<[string, string], { active: number; complete: number }>({ name: 'embedding.projectModel',
  sql: 'SELECT active,complete FROM embedding_models WHERE project_id=?1 AND model_key=?2' });
const projectTotals = read<[string, string], { state: SourceState; n: number }>({ name: 'embedding.projectTotals',
  sql: 'SELECT state,n FROM embedding_model_totals WHERE project_id=?1 AND model_key=?2' });
/** A reset admitted for the Project whose retirement pages have not finished. */
const projectResetting = read<[string], { found: number }>({ name: 'embedding.projectResetting',
  sql: `SELECT 1 AS found FROM embedding_resets WHERE project_id=?1
    AND EXISTS (SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0)` });
/** Projects that are not archived, read with the model's totals: bounded by Projects × states, never by sources. */
const deploymentTotals = read<[string], { state: SourceState; n: number }>({ name: 'embedding.deploymentTotals',
  sql: `SELECT t.state,SUM(t.n) AS n FROM projects p JOIN embedding_model_totals t ON t.project_id=p.project_id AND t.model_key=?1
    WHERE p.archived_at IS NULL GROUP BY t.state` });
/** A Project that is not archived, holds a source to embed, and whose model is not yet initialized there, or whose reset is still retiring. */
const deploymentInitializing = read<[string], { found: number }>({ name: 'embedding.deploymentInitializing',
  sql: `SELECT 1 AS found FROM projects p WHERE p.archived_at IS NULL
    AND ((NOT EXISTS (SELECT 1 FROM embedding_models k WHERE k.project_id=p.project_id AND k.model_key=?1 AND k.active=1 AND k.complete=1)
        AND EXISTS (SELECT 1 FROM embedding_eligible_sources e WHERE e.project_id=p.project_id))
      OR (EXISTS (SELECT 1 FROM embedding_resets r WHERE r.project_id=p.project_id)
        AND EXISTS (SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0))) LIMIT 1` });

function totals(rows: ReadonlyArray<{ state: SourceState; n: number }>, ready: boolean, asOf: number): ModelTotals {
  const byState = Object.fromEntries(SOURCE_STATES.map(state => [state, 0])) as Record<SourceState, number>;
  for (const row of rows) byState[row.state] += row.n;
  return { state: ready ? 'ready' : 'building', ready: byState.ready, total: SOURCE_STATES.reduce((sum, state) => sum + byState[state], 0), byState, asOf };
}

/**
 * Whether a model's vectors cover a Project's current sources, read from a fixed set of rows and never from the
 * sources: `building` until the state projection is installed, the model is active and initialized there (or the
 * Project holds no source to embed) and no reset is retiring, never zero in its place. Prompt-time recall reads this so a half-built model injects nothing.
 */
export async function modelReadiness(db: RelationalStore, projectId: string, model: string, asOf: number): Promise<ModelTotals> {
  const [phase, row, rows, resetting, sources] = await readSet(db, installed.bind(), projectModel.bind(projectId, model), projectTotals.bind(projectId, model),
    projectResetting.bind(projectId), hasSourcesToEmbed.bind(projectId));
  const initialized = (row[0] !== undefined && row[0].active === 1 && row[0].complete === 1) || sources[0]?.found !== 1;
  return totals(rows, phase[0]?.done === 1 && initialized && resetting.length === 0, asOf);
}

/** A model's progress across every Project that is not archived, from per-Project totals: what a switch's status shows. */
export async function modelProgress(db: RelationalStore, model: string, asOf: number): Promise<ModelTotals> {
  const [phase, rows, initializing] = await readSet(db, installed.bind(), deploymentTotals.bind(model), deploymentInitializing.bind(model));
  return totals(rows, phase[0]?.done === 1 && initializing.length === 0, asOf);
}
