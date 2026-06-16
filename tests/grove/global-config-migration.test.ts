import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  scrubEscapedSmokeLaunchers,
  scrubGeminiTrustedHooks,
} from '@myco/grove/global-config-migration.js';

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

describe('scrubEscapedSmokeLaunchers', () => {
  it('removes stale /tmp/myco-*-smoke launchers from nested Claude-style hook groups but preserves co-tenants', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: '"/Applications/GitKraken.app/Contents/MacOS/gk" ai hook run --host claude-code' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /tmp/myco-final-smoke-AAAA/home/launcher.cjs hook user-prompt-submit --symbiont claude-code', timeout: 5 }] },
            // NEW form (`<binary> hook … --myco-managed`, no `.cjs`) — the
            // current installed launcher; the scrub must leave it intact.
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && /Users/chris/.local/bin/myco hook user-prompt-submit --symbiont claude-code --myco-managed', timeout: 5 }] },
          ],
        },
      }, null, 2), 'utf-8');

      const out = scrubEscapedSmokeLaunchers(file);
      expect(out.entriesRemoved).toBe(1);
      expect(out.rewritten).toBe(true);

      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.hooks.UserPromptSubmit).toHaveLength(2);
      expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toContain('GitKraken');
      expect(after.hooks.UserPromptSubmit[1].hooks[0].command).toContain('--myco-managed');
    });
  });

  it('removes stale /tmp/myco-*-smoke launchers from flat Cursor/Windsurf hook entries', () => {
    withTmpFile((file) => {
      fs.writeFileSync(file, JSON.stringify({
        hooks: {
          sessionStart: [
            { command: 'node /tmp/myco-wave2-smoke-BBBB/home/launcher.cjs hook session-start --symbiont cursor' },
            { command: '/Users/chris/.local/bin/myco hook session-start --symbiont cursor --myco-managed' },
            { command: 'echo user-hook' },
          ],
        },
      }, null, 2), 'utf-8');

      const out = scrubEscapedSmokeLaunchers(file);
      expect(out.entriesRemoved).toBe(1);
      expect(out.rewritten).toBe(true);

      const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(after.hooks.sessionStart).toHaveLength(2);
      expect(after.hooks.sessionStart[0].command).toContain('--myco-managed');
      expect(after.hooks.sessionStart[1].command).toBe('echo user-hook');
    });
  });

  it('supports dry-run inspection via apply:false', () => {
    withTmpFile((file) => {
      const raw = JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /tmp/myco-cap-smoke-CCCC/home/launcher.cjs hook stop --symbiont claude-code' }] },
          ],
        },
      }, null, 2);
      fs.writeFileSync(file, raw, 'utf-8');

      const out = scrubEscapedSmokeLaunchers(file, { apply: false });
      expect(out.entriesRemoved).toBe(1);
      expect(out.rewritten).toBe(false);
      expect(fs.readFileSync(file, 'utf-8')).toBe(raw);
    });
  });

  // Generalized signature-based scrub: catches Myco's own escaped/old launcher
  // entries at ANY path (not just the smoke-specific `/tmp/myco-*/home/` one),
  // by the full `<launcher.cjs> hook <known-event> --symbiont <known-agent>`
  // signature, while leaving foreign hooks, genuine user wrappers, and the new
  // marker-bearing binary form untouched.
  describe('generalized launcher signature', () => {
    it('removes a real-dogfood launcher at an arbitrary temp path', () => {
      withTmpFile((file) => {
        fs.writeFileSync(file, JSON.stringify({
          hooks: {
            sessionStart: [
              { command: 'node /tmp/p2dogfood-daemon/launcher.cjs hook session-start --symbiont codex' },
            ],
          },
        }, null, 2), 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(1);
        expect(out.rewritten).toBe(true);
        const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(after.hooks.sessionStart).toHaveLength(0);
      });
    });

    it('removes the canonical OLD .myco/launcher.cjs shape (flat)', () => {
      withTmpFile((file) => {
        fs.writeFileSync(file, JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /Users/x/.myco/launcher.cjs hook stop --symbiont claude-code' },
            ],
          },
        }, null, 2), 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(1);
        expect(out.rewritten).toBe(true);
      });
    });

    it('removes the cd-prefixed OLD launcher shape', () => {
      withTmpFile((file) => {
        fs.writeFileSync(file, JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont claude-code', timeout: 5 }] },
            ],
          },
        }, null, 2), 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(1);
        expect(out.rewritten).toBe(true);
      });
    });

    it('removes other Myco launcher filenames (mcp-launcher / myco-run / myco-hook)', () => {
      withTmpFile((file) => {
        fs.writeFileSync(file, JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /tmp/x/myco-run.cjs hook stop --symbiont cursor' },
              { command: 'node /opt/foo/myco-hook.cjs hook stop --symbiont windsurf' },
            ],
          },
        }, null, 2), 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(2);
      });
    });

    it('PRESERVES the new marker-bearing binary form (no .cjs)', () => {
      withTmpFile((file) => {
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: '/abs/build/myco hook stop --symbiont claude-code --myco-managed' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
        expect(fs.readFileSync(file, 'utf-8')).toBe(raw);
      });
    });

    it('PRESERVES a user wrapper that invokes a launcher.cjs without the hook signature', () => {
      withTmpFile((file) => {
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: '/opt/my-wrappers/launcher.cjs --symbiont workerA' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('PRESERVES a launcher.cjs command with a trailing shell composition', () => {
      withTmpFile((file) => {
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /opt/me/launcher.cjs --symbiont cursor && my-thing' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('PRESERVES a full-signature command composed with a trailing operator (user-owned)', () => {
      withTmpFile((file) => {
        // Full Myco signature but user-composed: the trailing `&& my-notify`
        // means the user wrote this wrapper. Stripping it would break their hook.
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /opt/me/launcher.cjs hook stop --symbiont cursor && my-notify' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('PRESERVES another app\'s hook script', () => {
      withTmpFile((file) => {
        const raw = JSON.stringify({
          hooks: {
            sessionStart: [
              { command: '/Users/x/.superset/hooks/cursor-hook.sh Start' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('PRESERVES a full-signature launcher.cjs with an UNKNOWN symbiont', () => {
      withTmpFile((file) => {
        // workerA is not a known symbiont — fail-safe: leave it alone rather
        // than risk stripping a user/third-party hook that happens to ape the
        // shape.
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /opt/me/launcher.cjs hook stop --symbiont workerA' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('PRESERVES a full-signature launcher.cjs with an UNKNOWN event', () => {
      withTmpFile((file) => {
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              { command: 'node /opt/me/launcher.cjs hook frobnicate --symbiont cursor' },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });

    it('mixed event: removes escaped junk, keeps new-form and a user-app group', () => {
      withTmpFile((file) => {
        fs.writeFileSync(file, JSON.stringify({
          hooks: {
            Stop: [
              // escaped junk (old launcher.cjs, full signature, cd-prefixed)
              { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /tmp/p2dogfood-daemon/launcher.cjs hook stop --symbiont claude-code' }] },
              // new-form keeper (marker, no .cjs)
              { matcher: '', hooks: [{ type: 'command', command: '/abs/build/myco hook stop --symbiont claude-code --myco-managed' }] },
              // foreign user-app group
              { matcher: '', hooks: [{ type: 'command', command: '"/Applications/GitKraken.app/Contents/MacOS/gk" ai hook run --host claude-code' }] },
            ],
          },
        }, null, 2), 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(1);
        expect(out.rewritten).toBe(true);

        const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
        expect(after.hooks.Stop).toHaveLength(2);
        expect(after.hooks.Stop[0].hooks[0].command).toContain('--myco-managed');
        expect(after.hooks.Stop[1].hooks[0].command).toContain('GitKraken');
      });
    });

    it('nested group with a mix of matching and non-matching commands is preserved (every-match rule)', () => {
      withTmpFile((file) => {
        // A nested group is only removed when EVERY command matches. One foreign
        // command in the group protects the whole group.
        const raw = JSON.stringify({
          hooks: {
            Stop: [
              {
                matcher: '',
                hooks: [
                  { type: 'command', command: 'node /tmp/x/launcher.cjs hook stop --symbiont codex' },
                  { type: 'command', command: 'echo not-myco' },
                ],
              },
            ],
          },
        }, null, 2);
        fs.writeFileSync(file, raw, 'utf-8');

        const out = scrubEscapedSmokeLaunchers(file);
        expect(out.entriesRemoved).toBe(0);
        expect(out.rewritten).toBe(false);
      });
    });
  });
});
