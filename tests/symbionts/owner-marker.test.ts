import { describe, expect, it } from 'bun:test';
import {
  isMycoHookCommand,
  isMycoHookGroup,
} from '../../packages/myco/src/symbionts/install-helpers.js';

// Earlier installs stamped a `_meta.owner: myco` marker on every group as
// a redundant identity signal. The marker broke strict-schema agents
// (Windsurf silently rejects entries with unknown fields), so it was
// retired. Ownership is now identified solely by the canonical launcher
// path embedded in the command — the only signal that ever needed to
// exist. These tests cover the surviving behavior.

describe('Myco hook ownership — canonical launcher-path detection', () => {
  describe('isMycoHookCommand — strict canonical-path scan', () => {
    it('recognizes canonical global launcher', () => {
      expect(isMycoHookCommand('node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(true);
    });

    it('recognizes project-local launcher (.agents/myco-run.cjs)', () => {
      expect(isMycoHookCommand('cd $PROJECT && node .agents/myco-run.cjs hook session-start')).toBe(true);
    });

    it('recognizes published myco-run binary', () => {
      expect(isMycoHookCommand('myco-run hook user-prompt-submit')).toBe(true);
    });

    it('does NOT recognize sandboxed launcher path without canonical substring', () => {
      // The substring scan is intentionally strict — user-authored hooks
      // calling /tmp/.../launcher.cjs from a wrapper script must NOT be
      // identified as Myco-owned, because the user wrote them and we
      // cannot tell that from the command string.
      expect(isMycoHookCommand('node /tmp/myco-X-smoke-Y/home/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(false);
    });

    it('does not recognize unrelated commands', () => {
      expect(isMycoHookCommand('/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code')).toBe(false);
      expect(isMycoHookCommand('echo hello')).toBe(false);
    });

    it('does not false-positive on a user wrapper that invokes Myco from a non-canonical path', () => {
      // The user owns this hook; Myco must NEVER strip it on reinstall.
      // Canonical launcher paths are unique to Myco — third-party tenants
      // have no reason to call them — so a substring match is the
      // authoritative ownership signal.
      expect(isMycoHookCommand('node /opt/my-wrappers/launcher.cjs --symbiont workerA')).toBe(false);
    });
  });

  describe('isMycoHookGroup — launcher path is the only authoritative signal', () => {
    it('returns true for a nested group with a canonical-path launcher', () => {
      const group = { hooks: [{ command: 'node /Users/x/.myco/launcher.cjs hook stop --symbiont codex' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for a flat (Cursor/Windsurf) group with canonical-path launcher', () => {
      const group = { command: 'node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont cursor' };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns false for a user-authored wrapper that invokes Myco (non-canonical path)', () => {
      const userHook = { hooks: [{ command: 'node /opt/me/launcher.cjs --symbiont cursor && my-thing' }] };
      expect(isMycoHookGroup(userHook)).toBe(false);
    });

    it('returns false for unrelated third-party groups', () => {
      const gitkraken = { hooks: [{ command: '/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code' }] };
      expect(isMycoHookGroup(gitkraken)).toBe(false);
    });

    it('ignores any spurious _meta a previous install may have left behind', () => {
      // Pre-refactor installs stamped { _meta: { owner: 'myco' } } on every
      // group. The current detector treats _meta as data Myco doesn't care
      // about — ownership is determined by the launcher path alone, not by
      // residual metadata.
      const groupWithStaleMeta = {
        _meta: { owner: 'myco' },
        hooks: [{ command: 'echo hi' }],  // no canonical launcher path
      };
      expect(isMycoHookGroup(groupWithStaleMeta)).toBe(false);
    });
  });
});
