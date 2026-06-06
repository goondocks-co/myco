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
  effectiveTaskScheduleEnabled,
  governingCapability,
} from '../../packages/myco/src/config/capabilities';

function cfg(input: Record<string, unknown>) {
  return MycoConfigSchema.parse({ version: 3, ...input });
}

describe('governingCapability', () => {
  it('maps governed tasks', () => {
    expect(governingCapability('vault-evolve')).toBe('vault_evolution');
    expect(governingCapability('canopy-describe')).toBe('canopy');
    expect(governingCapability('title-summary')).toBeNull();
  });
});

describe('effectiveTaskScheduleEnabled', () => {
  it('returns false when the governing capability is off even if the task schedule is on', () => {
    expect(
      effectiveTaskScheduleEnabled(
        cfg({ vault_evolution: { enabled: false } }),
        'vault-evolve',
        true,
      ),
    ).toBe(false);
  });

  it('uses the YAML default when capability is on and no override is set', () => {
    expect(
      effectiveTaskScheduleEnabled(
        cfg({ vault_evolution: { enabled: true } }),
        'vault-evolve',
        true,
      ),
    ).toBe(true);
  });

  it('preserves default-off tasks when no override is set', () => {
    expect(effectiveTaskScheduleEnabled(cfg({}), 'canopy-describe', false)).toBe(false);
  });

  it('lets an explicit override enable a default-off task when capability is on', () => {
    expect(
      effectiveTaskScheduleEnabled(
        cfg({
          agent: {
            tasks: {
              'canopy-describe': { schedule: { enabled: true } },
            },
          },
        }),
        'canopy-describe',
        false,
      ),
    ).toBe(true);
  });

  it('fails closed on missing config', () => {
    expect(effectiveTaskScheduleEnabled(null, 'vault-evolve', true)).toBe(false);
  });
});
