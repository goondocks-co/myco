/*
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
import { propagateLegacySecrets } from '@myco/config/secrets.js';
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const [lockRoot, sourceVaultDir, destinationVaultDir, startedPath] = process.argv.slice(2);
if (!lockRoot || !sourceVaultDir || !destinationVaultDir || !startedPath) {
  process.stderr.write('secrets propagate helper: required args missing\n');
  process.exit(64);
}

fs.writeFileSync(startedPath, 'started\n');
propagateLegacySecrets(
  sourceVaultDir,
  destinationVaultDir,
  createPerUserLockNamespace(() => lockRoot),
);
