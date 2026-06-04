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

import { describe, it, expect } from 'bun:test';
import { resolveConfiguredRefs, resolveConfiguredRefsAsync } from '@myco/release-provenance/refs.js';

describe('resolveConfiguredRefsAsync', () => {
  it('matches the sync resolver for literal and wildcard refs', async () => {
    const root = process.cwd();
    const sync = resolveConfiguredRefs(root, ['HEAD', 'refs/heads/*']);
    const asyncRes = await resolveConfiguredRefsAsync(root, ['HEAD', 'refs/heads/*']);
    expect([...asyncRes].sort()).toEqual([...sync].sort());
  });

  it('returns literal refs unchanged and dedupes', async () => {
    const root = process.cwd();
    const res = await resolveConfiguredRefsAsync(root, ['HEAD', 'HEAD', '']);
    expect(res).toEqual(['HEAD']);
  });
});
