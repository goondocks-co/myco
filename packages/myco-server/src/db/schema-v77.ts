/** Short-lived device requests retain attributed decisions without retaining either code. */
export const V77_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS device_requests (
    id TEXT PRIMARY KEY,
    device_hash TEXT NOT NULL UNIQUE,
    user_hash TEXT NOT NULL UNIQUE,
    machine_id TEXT NOT NULL,
    machine_name TEXT NOT NULL,
    os TEXT NOT NULL,
    source_ip TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    interval_seconds INTEGER NOT NULL DEFAULT 5,
    next_poll_at INTEGER NOT NULL,
    slowed INTEGER NOT NULL DEFAULT 0,
    decision TEXT CHECK (decision IN ('approved', 'denied')),
    decided_by TEXT REFERENCES members(id),
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_requests_expiry ON device_requests(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_device_requests_decider ON device_requests(decided_by)`,
];
