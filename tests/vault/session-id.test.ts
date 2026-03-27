import { describe, it, expect } from 'vitest';
import {
  sessionNoteId,
  bareSessionId,
  sessionRelativePath,
} from '../../src/vault/session-id.js';

describe('session-id utilities', () => {
  describe('sessionNoteId', () => {
    it('adds session- prefix to bare ID', () => {
      expect(sessionNoteId('abc123')).toBe('session-abc123');
    });

    it('does not double-prefix', () => {
      expect(sessionNoteId('session-abc123')).toBe('session-abc123');
    });
  });

  describe('bareSessionId', () => {
    it('strips session- prefix', () => {
      expect(bareSessionId('session-abc123')).toBe('abc123');
    });

    it('returns bare ID unchanged', () => {
      expect(bareSessionId('abc123')).toBe('abc123');
    });
  });

  describe('sessionRelativePath', () => {
    it('builds date-based path', () => {
      expect(sessionRelativePath('abc123', '2026-03-16')).toBe('sessions/2026-03-16/session-abc123.md');
    });
  });
});
