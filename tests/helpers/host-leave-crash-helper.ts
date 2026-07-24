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
import path from 'node:path';
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const [lockRoot, teamHome, hostId, boundary] = process.argv.slice(2);
if (!lockRoot || !teamHome || !hostId || !boundary) process.exit(64);
process.env.MYCO_TEAM_HOME = teamHome;
process.env.HOME = teamHome;

const originalRename = fs.renameSync.bind(fs);
fs.renameSync = ((source: fs.PathLike, destination: fs.PathLike): void => {
  originalRename(source, destination);
  const sourcePath = String(source);
  const destinationPath = String(destination);
  const matches = boundary === 'retirement'
    && destinationPath.includes('/host-generations/')
    || boundary === 'host_dir'
      && path.basename(sourcePath) === hostId
      && path.basename(destinationPath).startsWith('.myco-remove-');
  if (matches) process.exit(86);
}) as typeof fs.renameSync;

const [{ leaveHost }, { FakeServiceManager }] = await Promise.all([
  import('@myco/host/member-overlay.js'),
  import('./fake-service-manager.js'),
]);
await leaveHost(hostId, {
  platform: 'darwin',
  serviceManager: new FakeServiceManager(),
  logger: () => {},
  lockNamespace: createPerUserLockNamespace(() => lockRoot),
});
