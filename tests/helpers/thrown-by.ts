/**
 * Copyright 2026 Goondocks Co.
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

/** The failure a child process reports through `execFileSync`. */
export interface SpawnFailure {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
}

/**
 * What `run` threw, or `null` when it returned. A caller asserts the `null`
 * case itself, so the assertion that something threw stands outside the
 * `try` that would otherwise swallow it.
 */
export function thrownBy<E = unknown>(run: () => unknown): E | null {
  try {
    run();
    return null;
  } catch (err) {
    return err as E;
  }
}
