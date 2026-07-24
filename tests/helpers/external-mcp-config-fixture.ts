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

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveGlobalConfigPath } from '@myco/grove/paths.js';

export function seedExternalMcpConfig(
  mycoHome: string,
  externalMcp: { enabled: boolean; port: number },
): void {
  const filePath = resolveGlobalConfigPath(mycoHome);
  const parsed = fs.existsSync(filePath)
    ? YAML.parse(fs.readFileSync(filePath, 'utf-8'))
    : {};
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const daemon = raw.daemon && typeof raw.daemon === 'object' && !Array.isArray(raw.daemon)
    ? raw.daemon as Record<string, unknown>
    : {};
  raw.daemon = {
    ...daemon,
    external_mcp: externalMcp,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(raw), 'utf-8');
}
