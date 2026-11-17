import { changed, trigger } from '../ddl.js';
import { LIVE_CAPTURE_FIELDS, liveEvidenceAdvances, liveEvidenceMax } from '../capture/live.js';
import { CAPTURE_RECEIPT_GRAIN_MS, namedCaptureHeadSelect, unnamedCaptureHeadSelect } from '../schema-v708.js';

const fields = ['project_id', 'machine_id', 'agent_json', 'session_id', 'last_received_at', ...LIVE_CAPTURE_FIELDS];
const receiptFields = ['project_id', 'session_id', 'last_received_at'];
const group = (row: string) => `machine_id=${row}.machine_id AND agent_json=json_quote(${row}.agent)`;
const winner = `excluded.last_received_at>machine_capture_heads.last_received_at OR
  (excluded.last_received_at=machine_capture_heads.last_received_at AND (excluded.project_id,excluded.session_id)<(machine_capture_heads.project_id,machine_capture_heads.session_id))`;
const advances = LIVE_CAPTURE_FIELDS.map(column => liveEvidenceAdvances('machine_capture_heads', column)).join(' OR ');
const recedes = LIVE_CAPTURE_FIELDS.map(column => `(OLD.${column} IS NOT NULL AND (NEW.${column} IS NULL OR OLD.${column}>NEW.${column}))`).join(' OR ');

/** Receipt identity and live evidence have independent monotonic orders within a machine/harness pair. */
function merge(select: string): string {
  return `INSERT INTO machine_capture_heads(${fields.join(',')}) ${select}
    ON CONFLICT(machine_id,agent_json) DO UPDATE SET
      ${receiptFields.map(column => `${column}=CASE WHEN ${winner} THEN excluded.${column} ELSE machine_capture_heads.${column} END`).join(',')},
      ${LIVE_CAPTURE_FIELDS.map(column => `${column}=${liveEvidenceMax('machine_capture_heads', column)}`).join(',')}
    WHERE ${winner} OR ${advances}`;
}

const minute = `(NEW.last_received_at-(NEW.last_received_at%${CAPTURE_RECEIPT_GRAIN_MS}+${CAPTURE_RECEIPT_GRAIN_MS})%${CAPTURE_RECEIPT_GRAIN_MS})`;
const incoming = `SELECT NEW.project_id,NEW.machine_id,json_quote(NEW.agent),NEW.session_id,${minute},NEW.last_live_received_at,NEW.last_trust_start_at WHERE 1`;
const live = (column: string) => `(SELECT s.${column} FROM sessions s
  WHERE s.machine_id=OLD.machine_id AND s.agent IS OLD.agent AND s.${column} IS NOT NULL ORDER BY s.${column} DESC LIMIT 1)`;
const receipt = `SELECT * FROM (${unnamedCaptureHeadSelect('OLD.machine_id')}) WHERE OLD.agent IS NULL
  UNION ALL SELECT * FROM (${namedCaptureHeadSelect('OLD.machine_id', 'OLD.agent')}) WHERE OLD.agent IS NOT NULL`;
const rebuild = [
  `DELETE FROM machine_capture_heads WHERE ${group('OLD')}`,
  merge(`SELECT r.*,${live('last_live_received_at')},${live('last_trust_start_at')} FROM (${receipt}) r WHERE 1`),
];
const owned = `EXISTS(SELECT 1 FROM machine_capture_heads WHERE ${group('OLD')} AND
  ((project_id,session_id)=(OLD.project_id,OLD.session_id) OR last_live_received_at=OLD.last_live_received_at OR last_trust_start_at=OLD.last_trust_start_at))`;
const columns = ['project_id', 'machine_id', 'agent', 'session_id', 'last_received_at', ...LIVE_CAPTURE_FIELDS];

/** Session mutations maintain receipt identity and live evidence together, including deletion and reassignment. */
export const captureHeadTriggers = () => [
  trigger('sessions_capture_head_insert', 'sessions', 'INSERT', merge(incoming), 'NEW.machine_id IS NOT NULL'),
  trigger('sessions_capture_head_update', 'sessions', `UPDATE OF ${columns.join(',')}`, merge(incoming), `NEW.machine_id IS NOT NULL AND (${changed(columns)})`),
  trigger('sessions_capture_head_reclassify', 'sessions', `UPDATE OF ${columns.join(',')}`, rebuild,
    `(${changed(['project_id', 'machine_id', 'agent', 'session_id'])} OR OLD.last_received_at>NEW.last_received_at OR
      ${recedes}) AND ${owned}`),
  trigger('sessions_capture_head_delete', 'sessions', 'DELETE', rebuild, owned),
];
