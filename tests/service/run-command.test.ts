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
import { spawnCombinedOutput } from '@myco/service/run-command.js';

describe('spawnCombinedOutput', () => {
  // Regression: the launchd/systemd runners accumulated output via
  // `string += buffer.toString()` per chunk, which mangles a multi-byte UTF-8
  // sequence split across a chunk boundary into U+FFFD. Emit > 64 KiB of
  // multi-byte characters so at least one sequence straddles a read boundary.
  it('decodes multi-byte UTF-8 spanning chunk boundaries without corruption', async () => {
    const count = 60_000; // 60k × 3 bytes (U+2014) = 180 KiB → many boundaries
    const script = `process.stdout.write('\\u2014'.repeat(${count}))`;
    const res = await spawnCombinedOutput(process.execPath, ['-e', script]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('�');
    expect(res.stdout.length).toBe(count);
    expect(res.stdout).toBe('—'.repeat(count));
  });

  it('appends stderr after stdout and reports a non-zero exit code', async () => {
    const script = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";
    const res = await spawnCombinedOutput(process.execPath, ['-e', script]);
    expect(res.stdout).toBe('outerr');
    expect(res.exitCode).toBe(3);
  });

  it('resolves (rather than hanging) when the command cannot be spawned', async () => {
    const res = await spawnCombinedOutput('this-command-does-not-exist-myco', ['x']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.length).toBeGreaterThan(0);
  });
});
