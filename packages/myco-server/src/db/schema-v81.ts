/** Persistent administrative receipts and indexed attempt history; readiness reports are transient. */
export const V81_STATEMENTS: readonly string[] = [
  `ALTER TABLE runners ADD COLUMN last_contact_at INTEGER`,
  `ALTER TABLE runners ADD COLUMN replacement_pending INTEGER NOT NULL DEFAULT 0 CHECK (replacement_pending IN (0,1))`,
  `UPDATE runners SET last_contact_at = (SELECT last_seen_at FROM runner_contacts WHERE runner_id = runners.id)
    WHERE EXISTS (SELECT 1 FROM runner_contacts WHERE runner_id = runners.id)`,
  `CREATE TRIGGER IF NOT EXISTS runner_contact_history_insert AFTER INSERT ON runner_contacts BEGIN
    UPDATE runners SET last_contact_at = MAX(COALESCE(last_contact_at, 0), NEW.last_seen_at), replacement_pending = 0 WHERE id = NEW.runner_id; END`,
  `CREATE TRIGGER IF NOT EXISTS runner_contact_history_update AFTER UPDATE OF last_seen_at ON runner_contacts BEGIN
    UPDATE runners SET last_contact_at = MAX(COALESCE(last_contact_at, 0), NEW.last_seen_at), replacement_pending = 0 WHERE id = NEW.runner_id; END`,
  `CREATE TRIGGER IF NOT EXISTS runner_replacement_pending AFTER UPDATE OF registration_id ON runners
    WHEN NEW.registration_id IS NOT OLD.registration_id BEGIN
    UPDATE runners SET replacement_pending = 1 WHERE id = NEW.id; END`,
  `ALTER TABLE device_requests ADD COLUMN replacing_runner_id TEXT REFERENCES runners(id)`,
  `CREATE INDEX IF NOT EXISTS idx_device_requests_replacing_runner ON device_requests(replacing_runner_id)`,
  `CREATE TABLE IF NOT EXISTS runner_observations (
    runner_id TEXT PRIMARY KEY REFERENCES runners(id), arch TEXT,
    availability TEXT NOT NULL CHECK (availability IN ('ready','settling','user_active','incompatible','unknown')),
    reason TEXT NOT NULL, observed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runner_metadata_audit (
    id TEXT PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES runners(id), actor_member TEXT REFERENCES members(id),
    action TEXT NOT NULL CHECK (action IN ('renamed','recredentialed')), revision INTEGER NOT NULL,
    detail TEXT NOT NULL CHECK (json_valid(detail)), at INTEGER NOT NULL,
    UNIQUE (runner_id, revision)
  )`,
  `CREATE TABLE IF NOT EXISTS legacy_worker_audit (
    id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES member_credentials(id), actor_member TEXT NOT NULL REFERENCES members(id),
    action TEXT NOT NULL CHECK (action = 'forgotten'), last_seen_at INTEGER NOT NULL, at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_legacy_worker_audit_actor ON legacy_worker_audit(actor_member)`,
  `CREATE INDEX IF NOT EXISTS idx_legacy_worker_audit_credential ON legacy_worker_audit(credential_id)`,
  `CREATE TRIGGER IF NOT EXISTS legacy_worker_audit_immutable BEFORE UPDATE ON legacy_worker_audit BEGIN
    SELECT RAISE(ABORT, 'legacy worker audit is immutable'); END`,
  `CREATE INDEX IF NOT EXISTS idx_runner_metadata_audit_actor ON runner_metadata_audit(actor_member)`,
  `CREATE TRIGGER IF NOT EXISTS runner_metadata_audit_immutable BEFORE UPDATE ON runner_metadata_audit BEGIN
    SELECT RAISE(ABORT, 'runner metadata audit is immutable'); END`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_queue ON agent_runs(status, task, held_by, queued_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_fleet_legacy_leases ON agent_runs(status, lease_expires_at, leased_by) WHERE leased_by IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_runner_attempt_history ON agent_run_attempts(runner_id, claimed_at DESC, attempt_id DESC)`,
  `DROP INDEX IF EXISTS idx_agent_run_attempts_runner`,
  `CREATE INDEX IF NOT EXISTS idx_runner_run_terminal ON agent_runs(leased_runner_id, status, completed_at DESC, id DESC)`,
];
