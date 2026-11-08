import { currentEmbeddingSourceSql } from '../../db/embedding-retirement.js';
import { RECEIPT as core_embedding_source_state_import_RECEIPT } from "../../core/embedding/receipt-state.js";

/** A receipt names an eligible source's current revision. */
const core_embedding_source_state_currentSource = currentEmbeddingSourceSql;

/** A calibration member names a current indexed spore receipt that is included in calibration. */
const core_embedding_source_state_currentHubnessMember = (row: string): string => `EXISTS (SELECT 1 FROM embedding_receipts r
  WHERE r.project_id = ${row}.project_id AND r.model_key = ${row}.model_key AND r.id = ${row}.id
    AND r.type = 'spore' AND r.ready = ${core_embedding_source_state_import_RECEIPT.ready} AND r.rewrites = 0 AND ${core_embedding_source_state_currentSource('r')})`;

/** One calibration probe: a statement and its binds, run by the calibration module that owns it. */
interface core_embedding_selection_EmbeddingQuery { sql: string; binds: unknown[] }

export { core_embedding_source_state_currentSource, core_embedding_source_state_currentHubnessMember, type core_embedding_selection_EmbeddingQuery };
