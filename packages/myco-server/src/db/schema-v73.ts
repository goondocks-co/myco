import { HARNESS_MEMBER_ID } from '../constants.js';

/** Existing human memberships require an explicit owner selection; empty Deployments bootstrap at first link. */
export const V73_STATEMENTS: readonly string[] = [
  `ALTER TABLE deployment_ownership ADD COLUMN bootstrap_mode TEXT NOT NULL DEFAULT 'selection' CHECK (bootstrap_mode IN ('fresh', 'selection'))`,
  `UPDATE deployment_ownership SET bootstrap_mode = 'fresh' WHERE member_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM members WHERE id <> '${HARNESS_MEMBER_ID}')`,
  `ALTER TABLE members ADD COLUMN role_revision INTEGER NOT NULL DEFAULT 0 CHECK (role_revision >= 0)`,
  `ALTER TABLE deployment_ownership_audit ADD COLUMN previous_member_id TEXT REFERENCES members(id)`,
  `ALTER TABLE deployment_ownership_audit ADD COLUMN operation TEXT NOT NULL DEFAULT 'bootstrap' CHECK (operation IN ('bootstrap', 'transfer'))`,
  `CREATE TABLE IF NOT EXISTS member_role_audit (
    member_id TEXT NOT NULL REFERENCES members(id), revision INTEGER NOT NULL,
    previous_role TEXT NOT NULL CHECK (previous_role IN ('admin', 'member')),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    actor_id TEXT NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL,
    PRIMARY KEY (member_id, revision))`,
  `CREATE TRIGGER IF NOT EXISTS member_role_audit_immutable BEFORE UPDATE ON member_role_audit BEGIN
    SELECT RAISE(ABORT, 'member role audit is immutable'); END`,
];
