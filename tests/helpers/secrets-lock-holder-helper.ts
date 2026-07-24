/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { secretStoreLockPath } from '@myco/config/secrets.js';

const [vaultDir, holdMsText, mode = 'write-race'] = process.argv.slice(2);
const holdMs = Number(holdMsText);

if (!vaultDir || !Number.isFinite(holdMs)) {
  process.stderr.write('secrets lock holder: required args missing\n');
  process.exit(64);
}

withFileLockSync(secretStoreLockPath(vaultDir), () => {
  fs.writeFileSync(path.join(vaultDir, 'secrets-lock-ready'), 'held\n');
  Bun.sleepSync(holdMs);
  const content = mode === 'delete-race'
    ? 'OLD=old\nCHILD_WRITER=child\n'
    : 'CHILD_WRITER=child\n';
  atomicWriteFileSync(path.join(vaultDir, 'secrets.env'), content, {
    encoding: 'utf-8',
    mode: 0o600,
  });
});
