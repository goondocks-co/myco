import { describe, expect, it } from 'bun:test';
import {
  MYCO_OWNER_MARKER_KEY,
  MYCO_OWNER_MARKER_VALUE,
  markGroupAsMyco,
  hasMycoOwnerMarker,
  isMycoHookCommand,
  isMycoHookGroup,
} from '../../packages/myco/src/symbionts/install-helpers.js';

describe('Myco owner marker — identity-based hook ownership', () => {
  describe('markGroupAsMyco', () => {
    it('stamps the marker key+value onto a group', () => {
      const group = { hooks: [{ command: 'whatever' }] };
      const tagged = markGroupAsMyco({ ...group });
      expect(tagged[MYCO_OWNER_MARKER_KEY]).toBe(MYCO_OWNER_MARKER_VALUE);
    });

    it('is idempotent — re-marking does not duplicate', () => {
      const tagged = markGroupAsMyco({ command: 'x' });
      const remarked = markGroupAsMyco(tagged);
      expect(remarked).toBe(tagged);
      expect(Object.keys(tagged).filter((k) => k === MYCO_OWNER_MARKER_KEY).length).toBe(1);
    });
  });

  describe('hasMycoOwnerMarker', () => {
    it('returns true for marker-tagged groups', () => {
      expect(hasMycoOwnerMarker({ [MYCO_OWNER_MARKER_KEY]: MYCO_OWNER_MARKER_VALUE })).toBe(true);
    });

    it('returns false for marker absent', () => {
      expect(hasMycoOwnerMarker({ hooks: [] })).toBe(false);
    });

    it('returns false for marker present but wrong value', () => {
      expect(hasMycoOwnerMarker({ [MYCO_OWNER_MARKER_KEY]: 'not-myco' })).toBe(false);
    });
  });

  describe('isMycoHookCommand — relocated-launcher fallback', () => {
    it('recognizes canonical global launcher', () => {
      expect(isMycoHookCommand('node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(true);
    });

    it('recognizes project-local launcher (.agents/myco-run.cjs)', () => {
      expect(isMycoHookCommand('cd $PROJECT && node .agents/myco-run.cjs hook session-start')).toBe(true);
    });

    it('recognizes sandboxed launcher path via filename + --symbiont flag', () => {
      // The exact shape of the orphan entries that escaped past the
      // pre-marker installer.
      expect(isMycoHookCommand('node /tmp/myco-wave2-smoke-k8fsGb/home/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(true);
    });

    it('recognizes published myco-run binary', () => {
      expect(isMycoHookCommand('myco-run hook user-prompt-submit')).toBe(true);
    });

    it('does not recognize unrelated commands', () => {
      expect(isMycoHookCommand('/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code')).toBe(false);
      expect(isMycoHookCommand('echo hello')).toBe(false);
    });

    it('does not false-positive on launcher.cjs WITHOUT --symbiont (some other tool happens to ship a launcher.cjs)', () => {
      expect(isMycoHookCommand('node /opt/some-other-tool/launcher.cjs run')).toBe(false);
    });
  });

  describe('isMycoHookGroup — marker takes precedence over substring', () => {
    it('returns true for marker-tagged group regardless of command shape', () => {
      const group = { [MYCO_OWNER_MARKER_KEY]: MYCO_OWNER_MARKER_VALUE, hooks: [{ command: 'echo hi' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for nested group whose command matches via legacy substring scan', () => {
      const group = { hooks: [{ command: 'node /Users/x/.myco/launcher.cjs hook stop --symbiont codex' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for flat group (Cursor/Windsurf shape) whose command matches via substring', () => {
      const group = { command: 'node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont cursor' };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for orphan sandboxed launcher (the bug shape)', () => {
      const orphan = { hooks: [{ command: 'node /tmp/myco-X-smoke-Y/home/launcher.cjs hook user-prompt-submit --symbiont claude-code' }] };
      expect(isMycoHookGroup(orphan)).toBe(true);
    });

    it('returns false for unrelated third-party groups', () => {
      const gitkraken = { hooks: [{ command: '/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code' }] };
      expect(isMycoHookGroup(gitkraken)).toBe(false);
    });
  });
});
