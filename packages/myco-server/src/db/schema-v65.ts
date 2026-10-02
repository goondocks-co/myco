/**
 * Schema v65: the models each worker last listed for each harness it offers.
 *
 * One row per claiming credential and harness, holding the catalog the worker reported (`catalog`, JSON as
 * `parseModelCatalog` keeps it), the machine it reported from, when the worker listed it and when the Deployment
 * received it. Settings offers the models these rows hold; a claim reads its worker's row to record what an alias it
 * requests resolves to. A row goes with its credential's worker contact.
 */
export const V65_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS worker_model_catalogs (
     credential_id TEXT NOT NULL,
     harness       TEXT NOT NULL,
     machine_id    TEXT,
     catalog       TEXT NOT NULL,
     fetched_at    INTEGER NOT NULL,
     received_at   INTEGER NOT NULL,
     PRIMARY KEY (credential_id, harness))`,
];
