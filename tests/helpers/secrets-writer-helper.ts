/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeSecret } from '@myco/config/secrets.js';

const [vaultDir, key, value] = process.argv.slice(2);
if (!vaultDir || !key || value === undefined) {
  process.stderr.write('secrets writer: required args missing\n');
  process.exit(64);
}

writeSecret(vaultDir, key, value);
