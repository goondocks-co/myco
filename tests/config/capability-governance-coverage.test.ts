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

import { describe, expect, it } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import {
  CAPABILITIES,
  effectiveTaskScheduleEnabled,
  governingCapability,
} from '../../packages/myco/src/config/capabilities';
import { setAtPath } from '../../packages/myco/src/utils/dot-path';

describe('capability scheduled-task governance coverage', () => {
  it('disables every governed scheduled task when its capability master gate is off', () => {
    for (const capability of Object.values(CAPABILITIES)) {
      const rawConfig: Record<string, unknown> = { version: 3 };
      setAtPath(rawConfig, capability.masterGate, false);
      const config = MycoConfigSchema.parse(rawConfig);

      for (const taskName of capability.scheduledTasks) {
        expect(governingCapability(taskName)).toBe(capability.id);
        expect(effectiveTaskScheduleEnabled(config, taskName, true)).toBe(false);
      }
    }
  });
});
