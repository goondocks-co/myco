/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { writeSecretIfAbsent } from '@myco/config/secrets.js';

const [vaultDir, holdMsText, mode = 'write-race', readyPath, releasePath] = process.argv.slice(2);
const holdMs = Number(holdMsText);

if (!vaultDir || !Number.isFinite(holdMs)) {
  process.stderr.write('secrets lock holder: required args missing\n');
  process.exit(64);
}

const holdOnly = new Error('hold-only');
try {
  writeSecretIfAbsent(vaultDir, 'CHILD_WRITER', () => {
    if (mode === 'file-replace') {
      atomicWriteFileSync(path.join(vaultDir, 'secrets.env'), 'REPLACED_DURING_LOCK=preserved\n', {
        encoding: 'utf-8',
        mode: 0o600,
      });
      fs.writeFileSync(path.join(vaultDir, 'secrets-replaced'), 'replaced\n');
    } else {
      if (mode === 'materialize') fs.mkdirSync(vaultDir, { recursive: true });
      fs.writeFileSync(readyPath ?? path.join(vaultDir, 'secrets-lock-ready'), 'held\n');
    }
    if (releasePath) {
      while (!fs.existsSync(releasePath)) Bun.sleepSync(10);
    } else {
      Bun.sleepSync(holdMs);
    }
    if (mode === 'hold-only') throw holdOnly;
    return 'child';
  });
} catch (error) {
  if (error !== holdOnly) throw error;
}
