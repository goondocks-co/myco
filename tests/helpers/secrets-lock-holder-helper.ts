/**
 * Copyright 2026 Myco Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { resolvePerUserLocksDir } from '@myco/utils/user-lock-root.js';

const [vaultDir, holdMsText, mode = 'write-race', postWriteMsText = '0'] = process.argv.slice(2);
const holdMs = Number(holdMsText);
const postWriteMs = Number(postWriteMsText);

if (!vaultDir || !Number.isFinite(holdMs) || !Number.isFinite(postWriteMs)) {
  process.stderr.write('secrets lock holder: required args missing\n');
  process.exit(64);
}

function canonicalDirectory(target: string): string {
  let current = path.resolve(target);
  const unresolved: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    unresolved.unshift(path.basename(current));
    current = parent;
  }
  current = fs.realpathSync(current);
  const resolved = path.join(current, ...unresolved);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const storeIdentity = path.join(canonicalDirectory(vaultDir), 'secrets.env');
const lockPath = path.join(
  resolvePerUserLocksDir(),
  'secrets',
  `${createHash('sha256').update(storeIdentity).digest('hex')}.lock`,
);
fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

withFileLockSync(lockPath, () => {
  fs.writeFileSync(path.join(vaultDir, 'secrets-lock-ready'), 'held\n');
  Bun.sleepSync(holdMs);
  if (mode !== 'hold-only') {
    const content = mode === 'delete-race'
      ? 'OLD=old\nCHILD_WRITER=child\n'
      : 'CHILD_WRITER=child\n';
    atomicWriteFileSync(path.join(vaultDir, 'secrets.env'), content, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
  if (mode === 'symlink-replace') {
    fs.writeFileSync(path.join(vaultDir, 'secrets-replaced'), 'replaced\n');
  }
  Bun.sleepSync(postWriteMs);
});
