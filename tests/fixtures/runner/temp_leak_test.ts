/**
 * A test that leaves temp state behind, for the runner's temp-containment gate
 * (`tests/scripts/run-bun-tests-guards.test.ts`). The `_test.ts` suffix
 * matches Bun's test pattern but not the runner's `*.test.*` discovery, so
 * only an explicit target runs it, and it leaks only when the gate sets
 * MYCO_RUNNER_TEMP_LEAK_FIXTURE.
 *
 * It creates a directory and a file under os.tmpdir(), has a child process
 * create another directory there, and removes none of them. With
 * MYCO_RUNNER_TEMP_LEAK_READY_FILE set it then writes its pid to that file and
 * waits, so the gate can stop the runner while the group is still running.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';

it.skipIf(process.env.MYCO_RUNNER_TEMP_LEAK_FIXTURE !== '1')('leaves a directory and files in the temp directory', async () => {
  fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-leak-'));
  fs.writeFileSync(path.join(os.tmpdir(), `myco-test-leak-file-${process.pid}`), 'left behind\n');
  const child = spawnSync(process.execPath, ['-e', "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'myco-test-leak-child-'))"]);
  expect(child.status).toBe(0);
  const ready = process.env.MYCO_RUNNER_TEMP_LEAK_READY_FILE;
  if (ready) {
    fs.writeFileSync(ready, `${process.pid}\n`);
    await new Promise(() => { setInterval(() => {}, 1 << 30); });
  }
});
