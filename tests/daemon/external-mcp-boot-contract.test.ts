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

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

test('daemon boot holds external MCP containment through startup handoff', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'packages/myco/src/daemon/main.ts'),
    'utf-8',
  );

  expect(source).toContain(
    "return await externalMcpContainment.containWhile('retire', async () => {",
  );
  expect(source).toContain('requireRetiredExternalMcp: true');
  expect(source).toContain('isRetiredExternalMcpDaemon(sibling)');
  expect(source).not.toContain("await externalMcpContainment.contain('retire');");
});
