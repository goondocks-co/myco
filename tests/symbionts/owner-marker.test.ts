import { describe, expect, it } from 'bun:test';
import {
  hasMycoManagedMarker,
  isMycoHookCommand,
  isMycoHookGroup,
  MYCO_MANAGED_MARKER,
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

  describe('isMycoHookCommand — --myco-managed marker (direct-binary form)', () => {
    it('recognizes a command carrying the --myco-managed marker regardless of binary path', () => {
      // The direct-binary hook form invokes a build-specific path (dogfood /
      // prod / worktree), so the marker — not the path — is the ownership
      // signal. Any binary path plus the marker is Myco-owned.
      expect(isMycoHookCommand('/some/build/myco-cli hook stop --symbiont claude-code --myco-managed')).toBe(true);
      expect(isMycoHookCommand(`/opt/dogfood/myco hook session-start --symbiont cursor ${MYCO_MANAGED_MARKER}`)).toBe(true);
    });

    it('does NOT claim a bare hook-shaped command lacking the marker AND a canonical path', () => {
      // A generic `hook <event> --symbiont <agent>` shape with neither the
      // marker nor a canonical launcher path is NOT Myco's — claiming it
      // would strip user-authored wrappers and escaped-smoke entries.
      expect(isMycoHookCommand('/some/build/myco-cli hook stop --symbiont claude-code')).toBe(false);
    });

    it('does NOT claim a command where the marker text is part of a longer flag or prose', () => {
      // Anchored match: the marker is a standalone trailing flag. A user file
      // containing `--myco-managed-strategy` or prose mentioning the marker
      // must NOT be claimed — and in uninstallPluginHookFile that match gates
      // DELETION of the user's file, so the precision is data-safety-critical.
      expect(isMycoHookCommand('/some/bin hook stop --symbiont claude-code --myco-managed-strategy')).toBe(false);
      expect(isMycoHookCommand('# comment: this was myco-managed by us')).toBe(false);
    });

    it('claims a command where the marker is followed by another flag (space-separated)', () => {
      // The marker need not be the very last token — only a standalone one.
      expect(isMycoHookCommand('/build/myco hook stop --symbiont claude-code --myco-managed --extra')).toBe(true);
    });
  });

  describe('hasMycoManagedMarker — anchored standalone-flag match', () => {
    it('matches the marker as a trailing flag', () => {
      expect(hasMycoManagedMarker('/build/myco hook stop --symbiont claude-code --myco-managed')).toBe(true);
    });

    it('matches the marker followed by another flag', () => {
      expect(hasMycoManagedMarker('/build/myco hook stop --myco-managed --extra')).toBe(true);
    });

    it('does NOT match the marker text embedded in a longer token', () => {
      expect(hasMycoManagedMarker('--myco-managed-strategy')).toBe(false);
    });

    it('does NOT match the marker text appearing in prose without a leading dash boundary', () => {
      expect(hasMycoManagedMarker('this was --myco-managedby us')).toBe(false);
      expect(hasMycoManagedMarker('myco-managed text')).toBe(false);
    });

    it('matches the marker when it is immediately followed by a JSON closing quote', () => {
      // rawHasMycoOwnershipSignal scans the serialized config file, where the
      // marker sits at the end of a JSON string value: `...--myco-managed"`.
      // A whitespace-only right anchor would miss this — the boundary must
      // admit the quote. (Regression: antigravity isConfigured() false-negative.)
      expect(hasMycoManagedMarker('{"command": "/bin hook stop --symbiont antigravity --myco-managed"}')).toBe(true);
    });
  });

  describe('isMycoHookCommand — backslash-path normalization (Windows)', () => {
    it('recognizes a backslash canonical launcher path', () => {
      // On Windows the wild hook command carries a backslash path. The
      // separator normalization makes Myco recognize its own entry; without
      // it the substring scan misses and the entries accumulate.
      expect(isMycoHookCommand('node C:\\Users\\chris\\.myco\\launcher.cjs hook stop --symbiont claude-code')).toBe(true);
    });

    it('does not newly claim a backslash NON-canonical wrapper path', () => {
      // Normalization is scoped to canonical Myco filenames — a user wrapper
      // at a non-canonical backslash path stays unclaimed.
      expect(isMycoHookCommand('node C:\\opt\\me\\launcher.cjs --symbiont cursor')).toBe(false);
    });
  });

  describe('isMycoHookGroup — --myco-managed marker', () => {
    it('returns true for a nested group whose command carries the marker', () => {
      const group = { hooks: [{ command: '/build/myco hook stop --symbiont codex --myco-managed' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for a flat group whose command carries the marker', () => {
      const group = { command: '/build/myco hook user-prompt-submit --symbiont cursor --myco-managed' };
      expect(isMycoHookGroup(group)).toBe(true);
    });
  });

  describe('locked contracts — escaped-smoke and user wrappers stay NON-owned', () => {
    // These cases are the data-safety guardrail: each carries neither the
    // --myco-managed marker NOR a canonical `.myco/launcher.cjs` (or other
    // MYCO_LAUNCHER_SUBSTRINGS) path, so backslash-normalization does not
    // newly match them. The escaped-smoke path ends in `/home/launcher.cjs`,
    // NOT `.myco/launcher.cjs`; a dedicated scrub in global-config-migration.ts
    // heals those — the installer must leave them alone.
    it('escaped-smoke launcher stays NON-owned', () => {
      expect(isMycoHookCommand('node /tmp/myco-X-smoke-Y/home/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(false);
    });

    it('user-authored flat wrapper stays NON-owned', () => {
      expect(isMycoHookCommand('node /opt/my-wrappers/launcher.cjs --symbiont workerA')).toBe(false);
    });

    it('user-authored nested wrapper group stays NON-owned', () => {
      const userHook = { hooks: [{ command: 'node /opt/me/launcher.cjs --symbiont cursor && my-thing' }] };
      expect(isMycoHookGroup(userHook)).toBe(false);
    });
  });
});
