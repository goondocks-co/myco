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
import { updateTierConfigRaw } from '@myco/config/loader.js';

const [mycoHome, readyPath, holdMsText] = process.argv.slice(2);
const holdMs = Number(holdMsText);
if (!mycoHome || !readyPath || !Number.isFinite(holdMs)) {
  process.stderr.write('machine config writer: required args missing\n');
  process.exit(64);
}

updateTierConfigRaw({ kind: 'machine' }, (raw) => {
  fs.writeFileSync(readyPath, 'held\n');
  Bun.sleepSync(holdMs);
  const daemon = raw.daemon && typeof raw.daemon === 'object' && !Array.isArray(raw.daemon)
    ? raw.daemon as Record<string, unknown>
    : {};
  raw.daemon = {
    ...daemon,
    log_level: 'debug',
  };
}, { mycoHome });
