/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SERVICE_SCOPE,
  UnsupportedServiceScopeError,
  resolveScope,
  type ServiceScope,
} from '@myco/service/types.js';

describe('resolveScope — the one normalizer both backends share (§13.3, §13.13 gates 2-3)', () => {
  it('an absent scope resolves to login + invoking-user — today\'s world', () => {
    expect(resolveScope({ label: 'co.goondocks.myco' })).toEqual({
      startAt: 'login',
      runAs: 'invoking-user',
    });
    expect(resolveScope({ label: 'x' })).toBe(DEFAULT_SERVICE_SCOPE);
  });

  it('login + root is refused on every platform — never degraded', () => {
    expect(() => resolveScope({
      label: 'co.goondocks.myco',
      scope: { startAt: 'login', runAs: 'root' },
    })).toThrow(UnsupportedServiceScopeError);
  });

  it('a declared scope with a FORGOTTEN runAs is refused — root is a value, never an absence', () => {
    // Reachable only via casts/dynamic construction; the runtime gate is the
    // backstop the type cannot provide (§13.13 gate 3: the gate fails on the
    // dangerous input — the missing field — not the supplied one).
    expect(() => resolveScope({
      label: 'co.goondocks.myco',
      scope: { startAt: 'boot' } as unknown as ServiceScope,
    })).toThrow(/without an explicit runAs/);
  });

  it('boot + invoking-user and boot + root pass through untouched', () => {
    const bootUser: ServiceScope = { startAt: 'boot', runAs: 'invoking-user' };
    const bootRoot: ServiceScope = { startAt: 'boot', runAs: 'root' };
    expect(resolveScope({ label: 'x', scope: bootUser })).toEqual(bootUser);
    expect(resolveScope({ label: 'x', scope: bootRoot })).toEqual(bootRoot);
  });
});
