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

/**
 * The decoded JSON body of a response, as the shape the caller names.
 *
 * Two declarations in the typecheck program disagree about an unread body.
 * `@cloudflare/workers-types` declares `Body.json<T>(): Promise<T>` with no
 * default, so the type parameter is open at the call. `bun:test` declares
 * `expect` with `(actual?: never): Matchers<undefined>` as its first overload,
 * which supplies `never` as the contextual type for its argument. Written
 * inline as `expect(await res.json()).toEqual(…)`, the open parameter binds to
 * that `never`, the first overload matches, and the matcher that comes back
 * accepts only `undefined`.
 *
 * `NoInfer` closes the parameter to contextual inference, so it keeps its
 * default and a nested read reaches the matcher as the shape it is.
 */
export async function jsonBody<T = unknown>(
  response: { json(): Promise<unknown> },
): Promise<NoInfer<T>> {
  return (await response.json()) as NoInfer<T>;
}
