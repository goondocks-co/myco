/**
 * `/mcp` is a RAW route — `DaemonServer.handleRequest` dispatches raw routes
 * and returns BEFORE the central per-project write gate. The entire phase-6
 * tool-front-door admission (`assertProjectAdmitsToolWrite`) exists because of
 * that fact; if someone later converts `/mcp` to an ordinary router route the
 * gate becomes redundant and nothing would say so. This pin keeps the
 * justification honest: change the registration, and this test names the
 * doctrine that has to be re-decided.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('/mcp raw-route pin', () => {
  test('main.ts registers /mcp via registerRawRoute (bypassing the central write gate)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'myco', 'src', 'daemon', 'main.ts'), 'utf8');
    expect(mainSrc).toMatch(/registerRawRoute\(\s*'\/mcp'/);
    // And no ordinary registration shadows it.
    expect(mainSrc).not.toMatch(/registerRoute\(\s*'[A-Z]+'\s*,\s*'\/mcp'/);
  });
});
