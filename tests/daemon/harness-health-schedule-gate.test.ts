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
 * harness-health has no governing capability, so `effectiveTaskScheduleEnabled`
 * alone fails open for it. Covers `resolveTaskScheduleEnabled`, which additionally
 * gates it on capture-only status.
 */
import { describe, expect, it } from 'bun:test';
import { resolveTaskScheduleEnabled } from '@myco/daemon/task-scheduling.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { HARNESS_HEALTH_TASK_NAME } from '@myco/notifications/harness-health-consumer.js';
import type { MycoConfig } from '@myco/config/schema.js';

function captureOnlyConfig(): MycoConfig {
  const cfg = MycoConfigSchema.parse({ version: 3 });
  cfg.cortex.enabled = false;
  cfg.cortex.canopy.enabled = false;
  cfg.skills.enabled = false;
  cfg.vault_evolution.enabled = false;
  return cfg;
}

describe('resolveTaskScheduleEnabled — harness-health capture-only gate', () => {
  it('skips harness-health on a capture-only project even though the YAML default is enabled', () => {
    expect(
      resolveTaskScheduleEnabled(captureOnlyConfig(), HARNESS_HEALTH_TASK_NAME, true),
    ).toBe(false);
  });

  it('runs harness-health when at least one capability is on', () => {
    const cfg = captureOnlyConfig();
    cfg.vault_evolution.enabled = true;
    expect(
      resolveTaskScheduleEnabled(cfg, HARNESS_HEALTH_TASK_NAME, true),
    ).toBe(true);
  });

  it('runs harness-health with every capability on (default config)', () => {
    const cfg = MycoConfigSchema.parse({ version: 3 });
    expect(
      resolveTaskScheduleEnabled(cfg, HARNESS_HEALTH_TASK_NAME, true),
    ).toBe(true);
  });

  it('fails closed on missing config (existing capabilityEnabled contract)', () => {
    expect(resolveTaskScheduleEnabled(null, HARNESS_HEALTH_TASK_NAME, true)).toBe(false);
  });

  it('does not affect ungoverned, non-harness-health tasks (capture-only has no bearing)', () => {
    expect(
      resolveTaskScheduleEnabled(captureOnlyConfig(), 'title-summary', true),
    ).toBe(true);
  });

  it('still gates vault-evolve on its own capability regardless of capture-only status', () => {
    const cfg = captureOnlyConfig();
    expect(resolveTaskScheduleEnabled(cfg, 'vault-evolve', true)).toBe(false);
    cfg.vault_evolution.enabled = true;
    expect(resolveTaskScheduleEnabled(cfg, 'vault-evolve', true)).toBe(true);
  });
});
