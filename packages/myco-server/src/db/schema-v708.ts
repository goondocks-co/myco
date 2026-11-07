import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const CAPTURE_RECEIPT_GRAIN_MS = 60_000;

const groupOf = (row: string) => `machine_id=${row}.machine_id AND agent_json=json_quote(${row}.agent)`;
const columns = 'project_id,machine_id,agent_json,session_id,last_received_at';
const receiptMinuteOf = (row: string) => `(${row}.last_received_at - ((${row}.last_received_at % ${CAPTURE_RECEIPT_GRAIN_MS} + ${CAPTURE_RECEIPT_GRAIN_MS}) % ${CAPTURE_RECEIPT_GRAIN_MS}))`;
const valuesOf = (row: string) => `${row}.project_id,${row}.machine_id,json_quote(${row}.agent),${row}.session_id,${receiptMinuteOf(row)}`;

/** Receipt minutes order heads; equal minutes choose the canonical project and session. */
function captureHeadInsert(select: string): string {
  return `INSERT INTO machine_capture_heads(${columns}) ${select}
    ON CONFLICT(machine_id,agent_json) DO UPDATE SET
      project_id=excluded.project_id,session_id=excluded.session_id,last_received_at=excluded.last_received_at
    WHERE excluded.last_received_at>machine_capture_heads.last_received_at
      OR (excluded.last_received_at=machine_capture_heads.last_received_at AND (excluded.project_id<machine_capture_heads.project_id OR (excluded.project_id=machine_capture_heads.project_id AND excluded.session_id<machine_capture_heads.session_id)));`;
}

/** The unnamed candidates for one machine, independent of its named session history. */
export function unnamedCaptureHeadSelect(machine: string): string {
  return `SELECT ${valuesOf('s')} FROM sessions s INDEXED BY idx_sessions_unnamed_machine
    WHERE s.machine_id=${machine} AND s.agent IS NULL
    ORDER BY ${receiptMinuteOf('s')} DESC,s.project_id,s.session_id LIMIT 1`;
}

/** Named-agent deletion and renaming require an equivalent machine-leading seek. */
function rebuildCaptureHead(): string {
  return `DELETE FROM machine_capture_heads WHERE ${groupOf('OLD')};
    ${captureHeadInsert(`SELECT * FROM (${unnamedCaptureHeadSelect('OLD.machine_id')}) WHERE OLD.agent IS NULL`)}
    ${captureHeadInsert(`SELECT ${valuesOf('s')} FROM sessions s
      WHERE OLD.agent IS NOT NULL AND s.machine_id=OLD.machine_id AND s.agent=OLD.agent
      ORDER BY ${receiptMinuteOf('s')} DESC,s.project_id,s.session_id LIMIT 1`)}`;
}

const headOfOld = `EXISTS (SELECT 1 FROM machine_capture_heads WHERE ${groupOf('OLD')} AND project_id=OLD.project_id AND session_id=OLD.session_id)`;
const changed = 'OLD.project_id IS NOT NEW.project_id OR OLD.machine_id IS NOT NEW.machine_id OR OLD.agent IS NOT NEW.agent OR OLD.session_id IS NOT NEW.session_id OR OLD.last_received_at IS NOT NEW.last_received_at';

/** Session-owned receipt heads have stable keys; polling reads one row per machine/agent across Projects. */
export const V708_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS machine_capture_heads (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
    machine_id TEXT NOT NULL,agent_json TEXT NOT NULL CHECK (json_valid(agent_json) AND json_type(agent_json) IN ('text','null')),
    session_id TEXT NOT NULL,last_received_at INTEGER NOT NULL,
    PRIMARY KEY(machine_id,agent_json)) WITHOUT ROWID`,
  `CREATE TRIGGER IF NOT EXISTS sessions_capture_head_insert AFTER INSERT ON sessions
    WHEN NEW.machine_id IS NOT NULL BEGIN
      ${captureHeadInsert(`SELECT ${valuesOf('NEW')} WHERE NEW.machine_id IS NOT NULL`)} END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_capture_head_update AFTER UPDATE OF project_id,machine_id,agent,session_id,last_received_at ON sessions
    WHEN NEW.machine_id IS NOT NULL AND (${changed}) BEGIN
      ${captureHeadInsert(`SELECT ${valuesOf('NEW')} WHERE NEW.machine_id IS NOT NULL`)} END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_capture_head_reclassify AFTER UPDATE OF project_id,machine_id,agent,session_id,last_received_at ON sessions
    WHEN (OLD.project_id IS NOT NEW.project_id OR OLD.machine_id IS NOT NEW.machine_id OR OLD.agent IS NOT NEW.agent
      OR OLD.session_id IS NOT NEW.session_id OR OLD.last_received_at>NEW.last_received_at) AND ${headOfOld}
    BEGIN ${rebuildCaptureHead()} END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_capture_head_delete AFTER DELETE ON sessions
    WHEN ${headOfOld} BEGIN ${rebuildCaptureHead()} END`,
  captureHeadInsert(`SELECT ${valuesOf('s')} FROM (
    SELECT project_id,machine_id,agent,session_id,last_received_at,
      ROW_NUMBER() OVER (PARTITION BY machine_id,agent ORDER BY ${receiptMinuteOf('sessions')} DESC,project_id,session_id) AS head_rank
    FROM sessions WHERE machine_id IS NOT NULL) s WHERE s.head_rank=1`),
];
