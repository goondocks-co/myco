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

/**
 * Structural sync test: every built-in task YAML with a `schedule` block
 * must be either mapped under some CAPABILITIES[*].scheduledTasks entry or
 * listed in EXEMPT_SCHEDULED_TASKS with a documented reason.
 */
import { describe, expect, it } from 'bun:test';
import { loadAgentTasks, resolveDefinitionsDir } from '../../packages/myco/src/agent/loader';
import { CAPABILITIES } from '../../packages/myco/src/config/capabilities';
import { HARNESS_HEALTH_TASK_NAME } from '../../packages/myco/src/notifications/harness-health-consumer';

/**
 * Scheduled tasks intentionally left out of the capability map. Each entry
 * must document why — a bare exemption defeats the point of this test.
 */
const EXEMPT_SCHEDULED_TASKS: Record<string, string> = {
  [HARNESS_HEALTH_TASK_NAME]:
    'Gated on isCaptureOnly at the scheduler admission seam, not a single capability master gate.',
};

function allGovernedTaskNames(): Set<string> {
  const governed = new Set<string>();
  for (const cap of Object.values(CAPABILITIES)) {
    for (const taskName of cap.scheduledTasks) governed.add(taskName);
  }
  return governed;
}

describe('scheduled-task governance enumeration (structural sync test)', () => {
  const tasks = loadAgentTasks(resolveDefinitionsDir());
  const scheduledTasks = tasks.filter((t) => t.schedule !== undefined);

  it('finds at least one scheduled task (sanity check the loader worked)', () => {
    expect(scheduledTasks.length).toBeGreaterThan(0);
  });

  it('every schedule-bearing task is governed by a capability or explicitly exempt', () => {
    const governed = allGovernedTaskNames();
    const ungoverned = scheduledTasks
      .map((t) => t.name)
      .filter((name) => !governed.has(name) && !(name in EXEMPT_SCHEDULED_TASKS));

    expect(ungoverned).toEqual([]);
  });

  it('every exempt task actually exists and actually has a schedule block (no stale exemptions)', () => {
    const scheduledNames = new Set(scheduledTasks.map((t) => t.name));
    for (const name of Object.keys(EXEMPT_SCHEDULED_TASKS)) {
      expect(scheduledNames.has(name)).toBe(true);
    }
  });

  it('audits to exactly the known set today (harness-health) — update this list deliberately, not by silencing the test above', () => {
    const governed = allGovernedTaskNames();
    const ungovernedOrExempt = scheduledTasks
      .map((t) => t.name)
      .filter((name) => !governed.has(name));
    expect(ungovernedOrExempt.sort()).toEqual([HARNESS_HEALTH_TASK_NAME]);
  });
});
