/** The Deployment's identity row and schema stamp, and the probe that proves the database answers. */
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

const stampedVersion = read<[], { value: string }>({ name: 'meta.schemaVersion', sql: `SELECT value FROM schema_meta WHERE key='version'` });
const deploymentId = read<[], { value: string }>({ name: 'meta.deploymentId', sql: `SELECT value FROM schema_meta WHERE key='deployment_id'` });
const readable = read<[], { readable: number }>({ name: 'meta.readProbe', sql: 'SELECT 1 AS readable' });

/** The schema version the bound database carries, or null when it carries none. */
export async function storedSchemaVersion(db: RelationalStore): Promise<number | null> {
  const [[row]] = await readSet(db, stampedVersion.bind());
  return row === undefined ? null : Number(row.value);
}

/** The Deployment lineage id the migrations seeded, or null where they have not run. */
export async function storedDeploymentId(db: RelationalStore): Promise<string | null> {
  const [[row]] = await readSet(db, deploymentId.bind());
  return row?.value ?? null;
}

/** Answers true only when the database returned the probe's row. */
export async function databaseAnswers(db: RelationalStore): Promise<boolean> {
  const [[row]] = await readSet(db, readable.bind());
  return row?.readable === 1;
}
