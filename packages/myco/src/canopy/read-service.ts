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

export interface CanopyEntryReadArgs {
  project_id: string;
  path: string;
}

export async function readCanopyEntry(
  args: CanopyEntryReadArgs,
): Promise<Record<string, unknown>> {
  const row = getDatabase().prepare(
    `SELECT * FROM canopy_entries WHERE project_id = ? AND path = ?`,
  ).get(args.project_id, args.path) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Canopy entry not found: ${args.path}`);
  return row;
}
