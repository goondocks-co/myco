import type { DeploymentIndex } from './schema-step.js';
/**
 * Schema v65: the models each machine's worker last listed for each harness it offers.
 *
 * One row per machine and harness, holding the catalog the worker reported (`catalog`, JSON as `parseModelCatalog`
 * keeps it), the resolutions it lists (`resolutions`, a JSON object from each model id to the model it resolves to),
 * when the worker listed it and when the Deployment received it. A machine's credentials rotate under it, and its
 * newest report replaces its last whichever credential sent it. Settings offers the models of the rows received
 * within the freshness window, and a claim reads the claiming machine's resolutions; the lease sweep forgets the rest.
 */
export const V65_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS worker_model_catalogs (
     machine_id  TEXT NOT NULL,
     harness     TEXT NOT NULL,
     catalog     TEXT NOT NULL,
     resolutions TEXT NOT NULL,
     fetched_at  INTEGER NOT NULL,
     received_at INTEGER NOT NULL,
     PRIMARY KEY (machine_id, harness))`,
  `CREATE INDEX IF NOT EXISTS idx_worker_model_catalogs_received ON worker_model_catalogs (received_at)`,
];

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V65_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_worker_model_catalogs_received', read: 'Settings reads the model lists machines sent lately, and the lease sweep forgets the rest by age; a machine names no Project' },
];
