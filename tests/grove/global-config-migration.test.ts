import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scrubGeminiTrustedHooks } from '@myco/grove/global-config-migration.js';

function withTmpFile<T>(fn: (filePath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-config-mig-'));
  const file = path.join(dir, 'trusted_hooks.json');
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('scrubGeminiTrustedHooks', () => {
  it('no-ops when the file is missing', () => {
    const file = path.join(os.tmpdir(), 'myco-global-config-mig-missing', 'trusted_hooks.json');
    const out = scrubGeminiTrustedHooks(file);
    expect(out.entriesRemoved).toBe(0);
    expect(out.rewritten).toBe(false);
    expect(out.error).toBeUndefined();
  });

  it('removes Gemini-era myco entries but preserves unrelated entries (e.g. OAK)', () => {
    withTmpFile((file) => {
      const input = {
        '/Users/x/proj-a': [
          'myco-session-start:cd "${GEMINI_PROJECT_DIR:-.}" && node .agents/myco-run.cjs hook session-start --symbiont gemini',
          'myco-stop:cd "${GEMINI_PROJECT_DIR:-.}" && node .agents/myco-run.cjs hook stop --symbiont gemini',
          'oak-ci-context:oak ci hook SessionStart --agent gemini',
        ],
        '/Users/x/proj-b': [
          'myco-pre-compact:cd "${GEMINI_PROJECT_DIR:-.}" && node .agents/myco-run.cjs hook pre-compact --symbiont gemini',
        ],
        '/Users/x/proj-c': [
          'oak-ci-stop:oak-dev ci hook Stop --agent gemini',
        ],
      };
      fs.writeFileSync(file, JSON.stringify(input, null, 2), 'utf-8');

      const out = scrubGeminiTrustedHooks(file);
      expect(out.entriesRemoved).toBe(3);
      expect(out.rewritten).toBe(true);

      const result = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // proj-a keeps the OAK entry; the two myco-gemini entries are gone.
      expect(result['/Users/x/proj-a']).toEqual([
        'oak-ci-context:oak ci hook SessionStart --agent gemini',
      ]);
      // proj-b becomes empty after the scrub — key removed entirely so
      // the file doesn't accrete dead empty arrays.
      expect(result['/Users/x/proj-b']).toBeUndefined();
      // proj-c is untouched.
      expect(result['/Users/x/proj-c']).toEqual([
        'oak-ci-stop:oak-dev ci hook Stop --agent gemini',
      ]);
    });
  });

  it('is idempotent: a second pass over the cleaned file is a no-op', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, JSON.stringify({
        '/Users/x/proj': [
          'myco-session-start:cd "${GEMINI_PROJECT_DIR:-.}" && node .agents/myco-run.cjs hook session-start --symbiont gemini',
          'oak-ci-context:oak ci hook SessionStart --agent gemini',
        ],
      }, null, 2), 'utf-8');

      const first = scrubGeminiTrustedHooks(file);
      expect(first.entriesRemoved).toBe(1);
      expect(first.rewritten).toBe(true);

      const second = scrubGeminiTrustedHooks(file);
      expect(second.entriesRemoved).toBe(0);
      expect(second.rewritten).toBe(false);
    });
  });

  it('leaves post-rename (--symbiont antigravity) entries alone', () => {
    withTmpFile((file) => {
      const input = {
        '/Users/x/proj': [
          // Post-rename: keeper. We do NOT touch the new --symbiont
          // antigravity entries here; they may be user-approved hooks
          // pointing at the current launcher.
          'myco-session-start:cd "${GEMINI_PROJECT_DIR:-.}" && node ~/.myco/launcher.cjs hook session-start --symbiont antigravity',
        ],
      };
      fs.writeFileSync(file, JSON.stringify(input, null, 2), 'utf-8');

      const out = scrubGeminiTrustedHooks(file);
      expect(out.entriesRemoved).toBe(0);
      expect(out.rewritten).toBe(false);
      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after['/Users/x/proj']).toHaveLength(1);
    });
  });

  it('reports an error for invalid JSON rather than corrupting the file', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, '{ not valid json', 'utf-8');
      const out = scrubGeminiTrustedHooks(file);
      expect(out.entriesRemoved).toBe(0);
      expect(out.rewritten).toBe(false);
      expect(out.error).toBe('invalid JSON');
      // File untouched.
      expect(fs.readFileSync(file, 'utf-8')).toBe('{ not valid json');
    });
  });
});
