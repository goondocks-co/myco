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

import { spawn } from 'node:child_process';

/** Throw with the command and its output when a supervisor shell-out exits non-zero. */
export function assertRunSucceeded(
  result: { stdout: string; stderr?: string; exitCode: number },
  command: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (exit ${result.exitCode}): ${(result.stdout + (result.stderr ?? '')).trim()}`);
  }
}

export interface RawCommandOutput {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** Collect complete stdout and stderr byte streams separately before decoding. */
export function spawnRawOutput(
  command: string,
  args: string[],
): Promise<RawCommandOutput> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => { outChunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { errChunks.push(b); });
    child.on('error', (err: Error) => resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(err.message), exitCode: 1 }));
    child.on('close', (code) => resolve({
      stdout: Buffer.concat(outChunks),
      stderr: Buffer.concat(errChunks),
      exitCode: code ?? 0,
    }));
  });
}

/** Decode each complete stream as UTF-8, appending stderr after stdout. */
export async function spawnCombinedOutput(command: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await spawnRawOutput(command, args);
  return { stdout: result.stdout.toString('utf8') + result.stderr.toString('utf8'), exitCode: result.exitCode };
}
