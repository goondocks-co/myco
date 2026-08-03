/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getDatabase } from '@myco/db/client.js';
import {
  getCanopyDescribeBacklog,
  DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS,
  canopyDescribeMaxAttempts,
  type CanopyDescribeBacklog,
} from '@myco/db/queries/canopy.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import {
  findRegisteredProject,
  listRegisteredProjects,
  loadGroveRecord,
} from '@myco/grove/registry.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { projectTreeAvailable } from '@myco/vault/resolve.js';
import { projectRuntimeIsForeign } from '@myco/daemon/update-checker.js';

export interface CanopyDescribeBacklogContext {
  /** Grove the request is bound to; consulted for grove-wide reads. */
  groveId?: string | null;
}

export interface CanopyDescribeBacklogReader {
  read(scope: ProjectScope, context?: CanopyDescribeBacklogContext): CanopyDescribeBacklog;
}

export interface CanopyDescribeBacklogReaderOptions {
  mycoHome?: string;
}

export function createCanopyDescribeBacklogReader(
  options: CanopyDescribeBacklogReaderOptions = {},
): CanopyDescribeBacklogReader {
  return {
    read(scope, context) {
      const groveId = context?.groveId ?? null;
      // Empty backlog for a Canopy-disabled project; unresolvable → don't filter.
      if (scope.kind === 'project' && groveId) {
        const home = options.mycoHome ?? resolveMycoHome();
        const found = findRegisteredProject({ projectId: scope.id, groveId }, home);
        if (found && !projectCanopyEnabled(found.project.root, groveId, home)) {
          return { pending: 0, undescribed: 0, stale: 0, stuck: 0 };
        }
      }
      const projectIds = scope.kind === 'all'
        ? serviceableProjectIds(groveId, options.mycoHome)
        : null;
      const maxAttempts = effectiveCanopyDescribeMaxAttempts(scope, groveId, options.mycoHome);
      return getCanopyDescribeBacklog(getDatabase(), scope, {
        maxAttempts,
        ...(projectIds ? { projectIds } : {}),
      });
    },
  };
}

// Registered, active projects with the Canopy capability enabled.
// Returns null (unrestricted count) when the grove record can't be loaded.
export function serviceableProjectIds(
  groveId: string | null,
  mycoHome?: string,
): string[] | null {
  if (!groveId) return null;
  const home = mycoHome ?? resolveMycoHome();
  if (!loadGroveRecord(groveId, home)) return null;
  return listRegisteredProjects(groveId, home)
    // A project pinned to a different MYCO_HOME is serviced by another
    // daemon — its rows must not count toward THIS daemon's backlog (they
    // would hold it out of deep sleep on work it will never run).
    .filter((project) => !projectRuntimeIsForeign(resolveProjectVaultDir(project.root), home))
    .filter((project) => projectCanopyEnabled(project.root, groveId, home))
    .map((project) => project.project_id);
}

// Canopy capability state from the project's merged config; unloadable → false.
function projectCanopyEnabled(
  projectRoot: string,
  groveId: string,
  mycoHome: string,
): boolean {
  let config: MycoConfig | null = null;
  try {
    const vaultDir = resolveProjectVaultDir(projectRoot);
    // A Team Host serving this project for a member has no local working
    // tree — degrade to machine+grove tiers (empty project tier) instead
    // of throwing "myco.yaml not found" (same signal + mechanism as
    // `task-scheduling.ts`). Without this, a served treeless project was
    // always excluded from the serviceable/enabled set below even when
    // its machine+grove tier has Canopy enabled.
    const treeAvailable = projectTreeAvailable(vaultDir);
    config = loadMergedConfig(vaultDir, { groveId, mycoHome, projectTierOptional: !treeAvailable });
  } catch {
    // unloadable config → capabilityEnabled(null) === false
  }
  return capabilityEnabled(config, 'canopy');
}

/**
 * Resolve the effective `max_attempts` cap for a backlog/reset scope.
 *
 * - `project` scope resolves the project's merged config (Grove-tier
 *   `agent.tasks.canopy-describe.params.max_attempts`) so eligible/stuck
 *   bucket correctly for projects that override the default.
 * - `all` / `global` scopes can't resolve a single project's override, so
 *   they take the yaml default. Grove-wide counts are therefore approximate
 *   for any project that raised the cap — documented, not a bug.
 *
 * Never throws: a missing registry entry or unreadable config falls back to
 * the default rather than failing the read.
 */
export function effectiveCanopyDescribeMaxAttempts(
  scope: ProjectScope,
  groveId: string | null,
  mycoHome?: string,
): number {
  if (scope.kind !== 'project' || !groveId) return DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
  const home = mycoHome ?? resolveMycoHome();
  try {
    const found = findRegisteredProject({ projectId: scope.id, groveId }, home);
    if (!found) return DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
    const vaultDir = resolveProjectVaultDir(found.project.root);
    // Same served-treeless degrade as `projectCanopyEnabled` above — a
    // Team Host reading a member project's max_attempts override has no
    // local working tree, so this must not throw "myco.yaml not found".
    const treeAvailable = projectTreeAvailable(vaultDir);
    const config = loadMergedConfig(vaultDir, {
      groveId,
      mycoHome: home,
      projectTierOptional: !treeAvailable,
    });
    return canopyDescribeMaxAttempts(config);
  } catch {
    return DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
  }
}
