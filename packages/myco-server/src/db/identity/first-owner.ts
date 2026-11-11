/**
 * What a first-owner setup reads. The hosted setup runs over the operator's store, which answers one statement per
 * request, so each read here is one statement outside any batch, as the setup's writes are (`writeAlone`).
 */
import type { RelationalStore } from '../../core/adapters.js';
import { read, type Bound } from '../index.js';
import { prepareBound } from '../kernel/statement.js';

interface FirstOwnerMember { id: string; role: string; github_id: string | null; revoked_at: number | null }

const schemaVersion = read<[], { value: string }>({ name: 'identity.firstOwnerSchemaVersion', sql: "SELECT value FROM schema_meta WHERE key = 'version'" });
const receipt = read<[key: string], { value: string }>({ name: 'identity.firstOwnerReceipt', sql: 'SELECT value FROM schema_meta WHERE key = ?1' });
const members = read<[], FirstOwnerMember>({ name: 'identity.firstOwnerMembers', sql: 'SELECT id, role, github_id, revoked_at FROM members LIMIT 2' });

const readAlone = async <Row>(db: RelationalStore, bound: Bound<Row, 'read'>): Promise<Row[]> => (await prepareBound(db, bound).all<Row>()).results;

/** The stamped schema version, or null where none is stamped. */
export async function firstOwnerSchemaVersion(db: RelationalStore): Promise<string | null> {
  return (await readAlone(db, schemaVersion.bind()))[0]?.value ?? null;
}

/** The member id the first-owner receipt under `key` names, or null where no setup claimed one. */
export async function firstOwnerReceipt(db: RelationalStore, key: string): Promise<string | null> {
  return (await readAlone(db, receipt.bind(key)))[0]?.value ?? null;
}

/** Up to two members: enough to tell none, the one an earlier setup made, and more. */
export const firstOwnerMembers = (db: RelationalStore): Promise<FirstOwnerMember[]> => readAlone(db, members.bind());
