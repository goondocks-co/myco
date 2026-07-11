/**
 * Subprocess helper for EventBuffer.deleteIfSync mutual-exclusion tests.
 *
 * Invoked as: `bun run tests/helpers/event-buffer-lock-holder-helper.ts <bufferDir> <sessionId> <holdMs>`
 *
 * Acquires the SAME per-session flock `EventBuffer.append` takes, then —
 * while holding it — writes a `<sessionId>.holder-ready` sentinel (so the
 * parent knows the lock is held), sleeps `holdMs`, and appends one JSONL
 * line to the session's buffer file before releasing. This is the shape of
 * the hook-fallback straggler writer: a cross-process appender that got the
 * lock first. A correct `deleteIfSync` in the parent must block on the flock
 * until this process releases, then observe the appended line in its in-lock
 * re-read and refuse the delete. Exits 0 on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';

const bufferDir = process.argv[2];
const sessionId = process.argv[3];
const holdMs = Number(process.argv[4]);

if (!bufferDir || !sessionId || !Number.isFinite(holdMs)) {
  process.stderr.write('lock-holder helper: required args missing\n');
  process.exit(64);
}

const lockPath = path.join(bufferDir, `.${sessionId}.lock`);
const filePath = path.join(bufferDir, `${sessionId}.jsonl`);
const sentinelPath = path.join(bufferDir, `${sessionId}.holder-ready`);

withFileLockSync(lockPath, () => {
  fs.writeFileSync(sentinelPath, 'held\n');
  Bun.sleepSync(holdMs);
  const line = JSON.stringify({
    type: 'user_prompt',
    session_id: sessionId,
    prompt: 'straggler-from-lock-holder',
    timestamp: new Date().toISOString(),
  });
  fs.appendFileSync(filePath, line + '\n');
});
process.exit(0);
