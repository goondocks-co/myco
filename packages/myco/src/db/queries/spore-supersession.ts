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

import { listGraphEdges } from '@myco/db/queries/graph-edges.js';
import { listResolutionEvents } from '@myco/db/queries/resolution-events.js';
import { RESOLUTION_ACTION } from '@myco/constants/spore-status.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';

export interface RecentSupersession {
  spore_id: string;
  new_spore_id: string;
  created_at: number;
}

export function listSupersedingSporeIds(
  sporeId: string,
  scope: ProjectScope,
  limit = 10,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const edges = listGraphEdges({
    scope,
    sourceId: sporeId,
    type: 'SUPERSEDED_BY',
    limit,
  });
  for (const edge of edges) {
    if (edge.target_type !== 'spore') continue;
    add(edge.target_id);
  }

  const events = listResolutionEvents({
    scope,
    spore_id: sporeId,
    limit,
  });
  for (const event of events) {
    if (event.action !== RESOLUTION_ACTION.SUPERSEDE || !event.new_spore_id) continue;
    add(event.new_spore_id);
  }

  return out;
}

export function listRecentSupersessions(
  scope: ProjectScope,
  sinceEpoch: number,
  limit: number,
): RecentSupersession[] {
  return listResolutionEvents({
    scope,
    action: RESOLUTION_ACTION.SUPERSEDE,
    created_after: sinceEpoch,
    has_new_spore_id: true,
    limit,
  })
    .map((event) => ({
      spore_id: event.spore_id,
      new_spore_id: event.new_spore_id!,
      created_at: event.created_at,
    }));
}
