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
 * A stand-in for the global `fetch`, for a test that replaces
 * `globalThis.fetch` rather than injecting a call.
 *
 * Bun declares the global with a `preconnect` member alongside the call, so a
 * bare handler is not a `typeof fetch`. This attaches a `preconnect` that does
 * nothing, which is what a test double owes a caller that never pre-resolves a
 * connection. A consumer that takes an injected fetch should be given the
 * handler directly — those parameters are typed as the call alone.
 */
export function globalFetchDouble(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} }) as typeof fetch;
}
