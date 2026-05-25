import { describe, expect, it } from 'bun:test';
import {
  MYCO_META_KEY,
  MYCO_OWNER_FIELD,
  MYCO_OWNER_VALUE,
  markGroupAsMyco,
  hasMycoOwnerMarker,
  isMycoHookCommand,
  isMycoHookGroup,
} from '../../packages/myco/src/symbionts/install-helpers.js';

describe('Myco owner marker — identity-based hook ownership', () => {
  describe('markGroupAsMyco', () => {
    it('stamps owner into the _meta namespace', () => {
      const group = { hooks: [{ command: 'whatever' }] };
      const tagged = markGroupAsMyco({ ...group });
      const meta = tagged[MYCO_META_KEY] as Record<string, unknown>;
      expect(meta[MYCO_OWNER_FIELD]).toBe(MYCO_OWNER_VALUE);
    });

    it('does not pollute the top-level group with foreign keys outside _meta', () => {
      const tagged = markGroupAsMyco({ command: 'x' });
      const topLevelKeys = Object.keys(tagged).filter((k) => k !== MYCO_META_KEY && k !== 'command');
      expect(topLevelKeys).toEqual([]);
    });

    it('is idempotent — re-marking does not duplicate', () => {
      const tagged = markGroupAsMyco({ command: 'x' });
      const remarked = markGroupAsMyco(tagged);
      expect(remarked).toBe(tagged);
      expect(Object.keys(tagged).filter((k) => k === MYCO_META_KEY).length).toBe(1);
    });

    it('preserves other _meta fields a future writer might add', () => {
      const group = { command: 'x', _meta: { someOtherField: 'preserve me' } };
      const tagged = markGroupAsMyco(group);
      const meta = tagged[MYCO_META_KEY] as Record<string, unknown>;
      expect(meta.someOtherField).toBe('preserve me');
      expect(meta[MYCO_OWNER_FIELD]).toBe(MYCO_OWNER_VALUE);
    });
  });

  describe('hasMycoOwnerMarker', () => {
    it('returns true for marker-tagged groups', () => {
      expect(hasMycoOwnerMarker({ [MYCO_META_KEY]: { [MYCO_OWNER_FIELD]: MYCO_OWNER_VALUE } })).toBe(true);
    });

    it('returns false for marker absent', () => {
      expect(hasMycoOwnerMarker({ hooks: [] })).toBe(false);
    });

    it('returns false for marker present but wrong value', () => {
      expect(hasMycoOwnerMarker({ [MYCO_META_KEY]: { [MYCO_OWNER_FIELD]: 'not-myco' } })).toBe(false);
    });

    it('returns false when _meta is present but lacks the owner field', () => {
      expect(hasMycoOwnerMarker({ [MYCO_META_KEY]: { someOtherField: 'foo' } })).toBe(false);
    });

    it('returns false for malformed _meta (not an object)', () => {
      expect(hasMycoOwnerMarker({ [MYCO_META_KEY]: 'oops' })).toBe(false);
    });
  });

  describe('isMycoHookCommand — strict canonical-path scan only', () => {
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
      // cannot tell that from the command string. The sandbox sentinel
      // closes the smoke-test escape that produced the original orphans.
      expect(isMycoHookCommand('node /tmp/myco-X-smoke-Y/home/launcher.cjs hook user-prompt-submit --symbiont claude-code')).toBe(false);
    });

    it('does not recognize unrelated commands', () => {
      expect(isMycoHookCommand('/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code')).toBe(false);
      expect(isMycoHookCommand('echo hello')).toBe(false);
    });

    it('does not false-positive on a user wrapper that invokes Myco from a non-canonical path', () => {
      // The user owns this hook; Myco must NEVER strip it on reinstall.
      // The marker is the only authority — if Myco didn't write it,
      // it's not Myco's to remove.
      expect(isMycoHookCommand('node /opt/my-wrappers/launcher.cjs --symbiont workerA')).toBe(false);
    });
  });

  describe('isMycoHookGroup — marker is the only authoritative signal', () => {
    it('returns true for marker-tagged group regardless of command shape', () => {
      const group = { [MYCO_META_KEY]: { [MYCO_OWNER_FIELD]: MYCO_OWNER_VALUE }, hooks: [{ command: 'echo hi' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for a nested group with a canonical-path launcher (legacy unmarked)', () => {
      const group = { hooks: [{ command: 'node /Users/x/.myco/launcher.cjs hook stop --symbiont codex' }] };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns true for a flat (Cursor/Windsurf) group with canonical-path launcher', () => {
      const group = { command: 'node /Users/x/.myco/launcher.cjs hook user-prompt-submit --symbiont cursor' };
      expect(isMycoHookGroup(group)).toBe(true);
    });

    it('returns false for a user-authored wrapper that invokes Myco (no marker, non-canonical path)', () => {
      const userHook = { hooks: [{ command: 'node /opt/me/launcher.cjs --symbiont cursor && my-thing' }] };
      expect(isMycoHookGroup(userHook)).toBe(false);
    });

    it('returns false for unrelated third-party groups', () => {
      const gitkraken = { hooks: [{ command: '/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code' }] };
      expect(isMycoHookGroup(gitkraken)).toBe(false);
    });
  });
});
