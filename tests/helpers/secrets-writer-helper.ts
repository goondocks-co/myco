/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeSecret } from '@myco/config/secrets.js';
import { createPerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

const [lockRoot, vaultDir, key, value] = process.argv.slice(2);
if (!lockRoot || !vaultDir || !key || value === undefined) {
  process.stderr.write('secrets writer: required args missing\n');
  process.exit(64);
}

writeSecret(vaultDir, key, value, createPerUserLockNamespace(() => lockRoot));
