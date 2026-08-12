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
  taskHasExplicitProvider,
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
    // canopy-describe carries the requiresTaskProvider gate (backstopped by
    // the bundled lookup even with no gate argument), so the provider is
    // part of what "enabled" requires for it.
    expect(
      effectiveTaskScheduleEnabled(
        cfg({
          agent: {
            tasks: {
              'canopy-describe': {
                provider: { type: 'lmstudio', model: 'openai/gpt-oss-20b' },
                schedule: { enabled: true },
              },
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

describe('requiresTaskProvider schedule gate', () => {
  const gate = { requiresTaskProvider: true };
  const enabledNoProvider = {
    agent: { tasks: { 'canopy-describe': { schedule: { enabled: true } } } },
  };

  it('blocks a flagged task with no explicit provider, even with an enabled override', () => {
    // Covers hand-edited configs: enabled: true in yaml alone must not run.
    expect(
      effectiveTaskScheduleEnabled(cfg(enabledNoProvider), 'canopy-describe', false, gate),
    ).toBe(false);
  });

  it('passes with a task-level provider', () => {
    expect(
      effectiveTaskScheduleEnabled(
        cfg({
          agent: {
            tasks: {
              'canopy-describe': {
                provider: { type: 'lmstudio', model: 'openai/gpt-oss-20b' },
                schedule: { enabled: true },
              },
            },
          },
        }),
        'canopy-describe',
        false,
        gate,
      ),
    ).toBe(true);
  });

  it('passes with a phase-level provider override', () => {
    expect(
      effectiveTaskScheduleEnabled(
        cfg({
          agent: {
            tasks: {
              'canopy-describe': {
                phases: { describe: { provider: { type: 'ollama', model: 'gemma3' } } },
                schedule: { enabled: true },
              },
            },
          },
        }),
        'canopy-describe',
        false,
        gate,
      ),
    ).toBe(true);
  });

  it('gates flagged bundled tasks even when the caller omits the gate argument', () => {
    // The bundled lookup backstops omitted arguments — a caller that
    // forgets the gate cannot silently drop it for built-in tasks.
    expect(
      effectiveTaskScheduleEnabled(cfg(enabledNoProvider), 'canopy-describe', false),
    ).toBe(false);
  });

  it('lets an explicit gate argument override the bundled lookup (user-authored task shape)', () => {
    expect(
      effectiveTaskScheduleEnabled(cfg(enabledNoProvider), 'canopy-describe', false, {
        requiresTaskProvider: false,
      }),
    ).toBe(true);
  });

  it('ignores a provider under a phase name the task does not have', () => {
    // A typo'd phase key parses (config schema allows arbitrary keys) but
    // no run ever resolves it — the executor matches by exact phase name
    // and falls back to the global provider. Counting it would satisfy the
    // gate while the spend still lands on the default provider.
    expect(
      effectiveTaskScheduleEnabled(
        cfg({
          agent: {
            tasks: {
              'canopy-describe': {
                phases: { descrbe: { provider: { type: 'ollama', model: 'gemma3' } } },
                schedule: { enabled: true },
              },
            },
          },
        }),
        'canopy-describe',
        false,
        gate,
      ),
    ).toBe(false);
  });
});

describe('taskHasExplicitProvider', () => {
  it('is false with no task entry, true with task provider, true with phase provider', () => {
    expect(taskHasExplicitProvider(cfg({}), 'canopy-describe')).toBe(false);
    expect(
      taskHasExplicitProvider(
        cfg({ agent: { tasks: { 'canopy-describe': { schedule: { enabled: true } } } } }),
        'canopy-describe',
      ),
    ).toBe(false);
    expect(
      taskHasExplicitProvider(
        cfg({ agent: { tasks: { 'canopy-describe': { provider: { type: 'anthropic' } } } } }),
        'canopy-describe',
      ),
    ).toBe(true);
    expect(
      taskHasExplicitProvider(
        cfg({ agent: { tasks: { 'canopy-describe': { phases: { describe: { provider: { type: 'anthropic' } } } } } } }),
        'canopy-describe',
      ),
    ).toBe(true);
  });
});
