import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';
import { runOriginSql } from './run-context.js';

/** Attempt prices and immutable execution identities; operator completion prepares the populated indexes. */
export const V103_STATEMENTS: readonly string[] = [
  'ALTER TABLE agent_run_attempts ADD COLUMN estimate_usd REAL CHECK(estimate_usd IS NULL OR estimate_usd>=0)',
  'ALTER TABLE agent_run_attempts ADD COLUMN cost_usd REAL CHECK(cost_usd IS NULL OR cost_usd>=0)',
  'ALTER TABLE agent_run_attempts ADD COLUMN cost_source TEXT',
  'ALTER TABLE agent_run_attempts ADD COLUMN profile_json TEXT',
  'ALTER TABLE agent_run_attempts ADD COLUMN settled_seq INTEGER CHECK(settled_seq IS NULL OR settled_seq>0)',
  "INSERT OR IGNORE INTO schema_meta(key,value) VALUES('budget.settlement_sequence','0')",
  ...['INSERT','UPDATE OF cost_usd'].map((event,index)=>`CREATE TRIGGER IF NOT EXISTS agent_attempt_settled_${index===0?'insert':'update'} AFTER ${event} ON agent_run_attempts
    WHEN NEW.cost_usd IS NOT NULL AND ${index===0?'1':'OLD.cost_usd IS NULL'} BEGIN
      UPDATE schema_meta SET value=CAST(MAX(CAST(value AS INTEGER),COALESCE(NEW.settled_seq,CAST(value AS INTEGER)+1)) AS TEXT) WHERE key='budget.settlement_sequence';
      UPDATE agent_run_attempts SET settled_seq=COALESCE(NEW.settled_seq,(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='budget.settlement_sequence'))
        WHERE project_id=NEW.project_id AND run_id=NEW.run_id AND attempt_id=NEW.attempt_id;
    END`),
  `CREATE TRIGGER IF NOT EXISTS agent_attempt_settlement_fixed BEFORE UPDATE OF settled_seq ON agent_run_attempts
    WHEN OLD.settled_seq IS NOT NULL AND NEW.settled_seq IS NOT OLD.settled_seq
    BEGIN SELECT RAISE(ABORT,'an attempt keeps its settlement order'); END`,
  "ALTER TABLE agent_runs ADD COLUMN origin TEXT CHECK(origin IN ('manual','automatic'))",
  `UPDATE agent_runs SET origin=${runOriginSql()} WHERE ${IN_FLIGHT_RUN_STATUSES} AND origin IS NULL`,
  `CREATE TRIGGER IF NOT EXISTS agent_runs_origin_insert AFTER INSERT ON agent_runs WHEN NEW.origin IS NULL BEGIN
    UPDATE agent_runs SET origin=${runOriginSql()} WHERE project_id=NEW.project_id AND id=NEW.id; END`,
  `CREATE TRIGGER IF NOT EXISTS agent_runs_origin_fixed BEFORE UPDATE OF origin ON agent_runs
    WHEN OLD.origin IS NOT NULL AND NEW.origin IS NOT OLD.origin BEGIN SELECT RAISE(ABORT,'a run keeps its dispatch origin'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_attempt_claim_fixed BEFORE UPDATE OF claimed_at,estimate_usd,profile_json ON agent_run_attempts
    WHEN NEW.claimed_at IS NOT OLD.claimed_at OR (OLD.estimate_usd IS NOT NULL AND NEW.estimate_usd IS NOT OLD.estimate_usd)
      OR (OLD.profile_json IS NOT NULL AND NEW.profile_json IS NOT OLD.profile_json)
    BEGIN SELECT RAISE(ABORT,'an attempt keeps its claim evidence'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_attempt_cost_fixed BEFORE UPDATE OF cost_usd,cost_source ON agent_run_attempts
    WHEN OLD.cost_usd IS NOT NULL AND (NEW.cost_usd IS NOT OLD.cost_usd OR (OLD.cost_source IS NOT NULL AND NEW.cost_source IS NOT OLD.cost_source))
    BEGIN SELECT RAISE(ABORT,'settled attempt cost evidence conflicts'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_attempt_machine_fixed BEFORE UPDATE OF machine_id ON agent_run_attempts
    WHEN OLD.machine_id IS NOT NULL AND NEW.machine_id IS NOT OLD.machine_id
    BEGIN SELECT RAISE(ABORT,'an attempt keeps its claim machine'); END`,
];
