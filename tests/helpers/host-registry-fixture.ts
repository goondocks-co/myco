/*
 * Copyright 2026 Myco Contributors
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

import {
  resolveHostConfigPath,
  resolveHostDir,
} from '@myco/grove/paths.js';
import type { HostRecord } from '@myco/host/registry.js';

export function writeHostRecordFixture(record: HostRecord): void {
  fs.mkdirSync(resolveHostDir(record.host_id), { recursive: true });
  fs.writeFileSync(
    resolveHostConfigPath(record.host_id),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}
