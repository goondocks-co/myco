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
import type { MycoConfig } from '@myco/config/schema.js';

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

// Grove-wide backlog counts must reflect work the scribe can actually
// service: active registered projects only. Rows left behind by deleted
// projects (pre-cascade orphans) or held by archived projects would
// otherwise inflate the dashboard with work no scheduled run will drain.
// When the grove record can't be loaded the registry is unavailable, so
// fall back to the unrestricted count rather than report a false zero.
export function serviceableProjectIds(
  groveId: string | null,
  mycoHome?: string,
): string[] | null {
  if (!groveId) return null;
  const home = mycoHome ?? resolveMycoHome();
  if (!loadGroveRecord(groveId, home)) return null;
  return listRegisteredProjects(groveId, home).map((project) => project.project_id);
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
    const config = loadMergedConfig(resolveProjectVaultDir(found.project.root), {
      groveId,
      mycoHome: home,
    });
    return canopyDescribeMaxAttempts(config);
  } catch {
    return DEFAULT_CANOPY_DESCRIBE_MAX_ATTEMPTS;
  }
}
