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

import { expect, test } from 'bun:test';
import { execSync } from 'node:child_process';

/**
 * §13.12 (Overlay Coexistence spec, R-M8): boot scope is VERIFIED SAFE on
 * macOS because the daemon depends on nothing a system-domain job loses —
 * notifications are in-app (no osascript/terminal-notifier/notify-send) and
 * secrets are file-based (no login-keychain use). That was an observation;
 * this gate makes it a STATED DEPENDENCY: the day someone adds a native
 * notification or keychain call, this fails and forces the boot-scope
 * conversation instead of a silently-broken boot-scoped daemon.
 */
test('the daemon has no user-session dependencies (native notifications, login keychain)', () => {
  const hits = execSync(
    "grep -rnE 'osascript|terminal-notifier|notify-send|security find-generic-password|node-keytar|keytar' "
    + '--include="*.ts" packages/myco/src packages/myco-collective 2>/dev/null || true',
    { cwd: process.cwd(), encoding: 'utf-8' },
  ).trim().split('\n').filter(Boolean);
  expect(hits).toEqual([]);
});
