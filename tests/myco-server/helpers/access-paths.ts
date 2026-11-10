/**
 * Indexes read by a Deployment-wide access path rather than by Project.
 *
 * Every index on a Project-scoped table leads with `project_id`, and two gates hold that (`gates.test.ts` over the live
 * schema indexes, `schema.test.ts` over the v2 tables). The exceptions both gates admit are declared on the schema step
 * that creates each index (`deploymentIndexes`), with the Deployment-wide read it serves, so a new exception is
 * declared beside its index and judged the same way by both.
 */
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';

export const DEPLOYMENT_ACCESS_PATH_INDEXES: ReadonlyMap<string, string> = new Map(
  SCHEMA_STEPS.flatMap((step) => (step.deploymentIndexes ?? []).map(({ index, read }) => [index, read] as const)),
);

/** True when `statement` creates one of the indexes above. */
export function isDeploymentAccessPath(statement: string): boolean {
  const name = /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/.exec(statement)?.[1];
  return name !== undefined && DEPLOYMENT_ACCESS_PATH_INDEXES.has(name);
}
