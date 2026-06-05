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

import YAML from 'yaml';

/**
 * Drop top-level sections whose serialized value equals the schema default,
 * while preserving required bookkeeping scalars such as `version`.
 *
 * This is deliberately section-granular: if any nested value in a section is
 * non-default, the whole section remains intact.
 */
export function stripDefaultSections<T extends Record<string, unknown>>(
  value: T,
  defaults: Record<string, unknown>,
  keep: ReadonlyArray<string>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (value[key] !== undefined) out[key] = value[key];
  }

  for (const [key, section] of Object.entries(value)) {
    if (keep.includes(key)) continue;
    if (YAML.stringify(section) !== YAML.stringify(defaults[key])) {
      out[key] = section;
    }
  }

  return out as Partial<T>;
}
