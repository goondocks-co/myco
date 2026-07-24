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
  attachProject,
  persistEnrollmentMembership,
  type AttachRef,
  type EnrollmentHostRecord,
} from '@myco/host/registry.js';

interface EnrollmentOperation {
  mode: 'enroll';
  record: EnrollmentHostRecord;
  bearer: string;
}

interface AttachOperation {
  mode: 'attach';
  hostId: string;
  ref: AttachRef;
}

type RegistryOperation = EnrollmentOperation | AttachOperation;

const [teamHome, payloadPath, startedPath, completedPath] = process.argv.slice(2);
if (!teamHome || !payloadPath || !startedPath || !completedPath) {
  process.stderr.write('host registry operation helper: required args missing\n');
  process.exit(64);
}

process.env.MYCO_TEAM_HOME = teamHome;
const operation = JSON.parse(fs.readFileSync(payloadPath, 'utf-8')) as RegistryOperation;
fs.writeFileSync(startedPath, 'started\n');

try {
  if (operation.mode === 'enroll') {
    persistEnrollmentMembership(operation.record, operation.bearer);
  } else {
    attachProject(operation.hostId, operation.ref);
  }
  fs.writeFileSync(completedPath, JSON.stringify({ ok: true }));
} catch (error) {
  fs.writeFileSync(completedPath, JSON.stringify({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
