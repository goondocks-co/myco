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
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const [lockRoot, hookName] = process.argv.slice(2);
if (!lockRoot || !hookName) process.exit(64);

const hookLoaders = {
  'error-occurred': () => import('@myco/hooks/error-occurred.js'),
  notification: () => import('@myco/hooks/notification.js'),
  'post-compact': () => import('@myco/hooks/post-compact.js'),
  'post-tool-use': () => import('@myco/hooks/post-tool-use.js'),
  'post-tool-use-failure': () => import('@myco/hooks/post-tool-use-failure.js'),
  'pre-tool-use': () => import('@myco/hooks/pre-tool-use.js'),
  'pre-compact': () => import('@myco/hooks/pre-compact.js'),
  'session-end': () => import('@myco/hooks/session-end.js'),
  'session-start': () => import('@myco/hooks/session-start.js'),
  'stop-failure': () => import('@myco/hooks/stop-failure.js'),
  stop: () => import('@myco/hooks/stop.js'),
  'subagent-start': () => import('@myco/hooks/subagent-start.js'),
  'subagent-stop': () => import('@myco/hooks/subagent-stop.js'),
  'task-completed': () => import('@myco/hooks/task-completed.js'),
  'user-prompt-submit': () => import('@myco/hooks/user-prompt-submit.js'),
} as const;

const loader = hookLoaders[hookName as keyof typeof hookLoaders];
if (!loader) process.exit(64);

const hook = await loader();
await hook.main(createPerUserLockNamespace(() => lockRoot));
