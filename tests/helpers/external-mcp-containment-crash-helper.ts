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
import {
  ExternalMcpContainmentAuthority,
  externalMcpContainmentIntentPath,
} from '@myco/daemon/external-mcp-containment.js';
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const home = process.env.MYCO_TEST_HOME;
if (!home) throw new Error('MYCO_TEST_HOME is required');
const crashAt = process.env.MYCO_TEST_CRASH_AT ?? 'none';
const stateDir = path.join(home, 'service');
const configPath = path.join(home, 'config.yaml');
const funnelStatePath = path.join(home, 'funnel.state');
const listenerStatePath = path.join(home, 'listener.state');
const intentPath = externalMcpContainmentIntentPath(stateDir);
const lockRoot = path.join(home, 'test-locks');
fs.mkdirSync(lockRoot, { recursive: true });

const crash = (): never => {
  process.exit(91);
};

const originalRename = fs.renameSync.bind(fs);
fs.renameSync = ((source, destination) => {
  originalRename(source, destination);
  if (crashAt === 'config_commit' && String(destination) === configPath) crash();
  if (crashAt === 'journal_clear' && String(source) === intentPath) crash();
}) as typeof fs.renameSync;

const listener = {
  get isBound() {
    return fs.readFileSync(listenerStatePath, 'utf-8').trim() === 'bound';
  },
  get port() {
    return this.isBound ? 8743 : 0;
  },
  async unbind() {
    fs.writeFileSync(listenerStatePath, 'unbound\n');
    if (crashAt === 'listener_unbind') crash();
  },
};

const authority = new ExternalMcpContainmentAuthority({
  mycoHome: home,
  stateDir,
  listener,
  runFunnelOff: async () => {
    if (crashAt === 'journal_published') crash();
    fs.writeFileSync(funnelStatePath, 'off\n');
    if (crashAt === 'off_side_effect') crash();
    return { ok: true, detail: 'off 8743' };
  },
  lockNamespace: createPerUserLockNamespace(() => lockRoot),
});

await authority.contain('retire');
