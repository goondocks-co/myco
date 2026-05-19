/**
 * Subprocess helper for EventBuffer concurrent-writer tests.
 *
 * Invoked as: `bun run tests/helpers/event-buffer-appender-helper.ts <bufferDir> <sessionId> <count> <writerId>`
 *
 * Opens an EventBuffer for the supplied session and appends `count`
 * events whose `tool_input` is a >PIPE_BUF blob so non-atomic writes
 * would corrupt JSONL lines without the flock guard. Exits 0 on
 * success.
 */

import { EventBuffer } from '@myco/capture/buffer.js';

const bufferDir = process.argv[2];
const sessionId = process.argv[3];
const count = Number(process.argv[4]);
const writerId = process.argv[5];

if (!bufferDir || !sessionId || !Number.isFinite(count) || !writerId) {
  process.stderr.write('appender helper: required args missing\n');
  process.exit(64);
}

const blob = 'x'.repeat(6000); // > PIPE_BUF (4096)
const buffer = new EventBuffer(bufferDir, sessionId);
for (let i = 0; i < count; i++) {
  buffer.append({
    type: 'tool_use',
    tool_name: 'Bash',
    tool_input: { writer: writerId, seq: i, blob },
    timestamp: new Date().toISOString(),
  });
}
process.exit(0);
