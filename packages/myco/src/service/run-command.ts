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
  result: { stdout: string; exitCode: number },
  command: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (exit ${result.exitCode}): ${result.stdout.trim()}`);
  }
}

/**
 * Spawn a command and return its combined stdout+stderr decoded once, plus the
 * exit code. Used by the launchd/systemd service runners, whose shell-outs were
 * byte-for-byte identical apart from the binary name.
 *
 * Accumulates raw Buffers and decodes the complete byte stream a single time.
 * `string += buffer.toString()` per chunk decodes each chunk independently, so
 * a multi-byte UTF-8 sequence split across a chunk boundary is mangled into
 * U+FFFD; decoding once (matching execFileSync) keeps the output byte-accurate.
 * stdout is decoded then stderr is appended, so a multi-byte sequence can never
 * straddle the two streams.
 */
export function spawnCombinedOutput(
  command: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => { outChunks.push(b); });
    child.stderr.on('data', (b: Buffer) => { errChunks.push(b); });
    // Without this, a failed spawn (ENOENT) emits 'error' but never 'close',
    // leaving the promise pending forever.
    child.on('error', (err: Error) => resolve({ stdout: String(err.message), exitCode: 1 }));
    child.on('close', (code) => resolve({
      stdout: Buffer.concat(outChunks).toString('utf8') + Buffer.concat(errChunks).toString('utf8'),
      exitCode: code ?? 0,
    }));
  });
}
