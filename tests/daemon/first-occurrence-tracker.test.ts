/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from 'bun:test';
import {
  createBoundedFirstOccurrenceTracker,
  MISSING_SESSION_LOG_SCOPE_KEY,
  sessionLogScopeKey,
} from '@myco/daemon/first-occurrence-tracker.js';

describe('createBoundedFirstOccurrenceTracker', () => {
  it('returns first once for a key, then repeat', () => {
    const tracker = createBoundedFirstOccurrenceTracker();

    expect(tracker.mark('session_id:value:sess-1')).toBe('first');
    expect(tracker.mark('session_id:value:sess-1')).toBe('repeat');
    expect(tracker.mark('session_id:value:sess-2')).toBe('first');
  });

  it('clears old keys before admitting a new key beyond the configured bound', () => {
    const tracker = createBoundedFirstOccurrenceTracker({ maxKeys: 2 });

    expect(tracker.mark('one')).toBe('first');
    expect(tracker.mark('two')).toBe('first');
    expect(tracker.size).toBe(2);

    expect(tracker.mark('three')).toBe('first');
    expect(tracker.size).toBe(1);
    expect(tracker.mark('one')).toBe('first');
  });

  it('rejects invalid bounds instead of silently disabling the latch', () => {
    expect(() => createBoundedFirstOccurrenceTracker({ maxKeys: 0 })).toThrow(
      'FirstOccurrenceTracker maxKeys must be a positive integer',
    );
    expect(() => createBoundedFirstOccurrenceTracker({ maxKeys: 1.5 })).toThrow(
      'FirstOccurrenceTracker maxKeys must be a positive integer',
    );
  });
});

describe('sessionLogScopeKey', () => {
  it('uses a named missing-session scope instead of an inline sentinel', () => {
    expect(sessionLogScopeKey(undefined)).toBe(MISSING_SESSION_LOG_SCOPE_KEY);
  });

  it('namespaces real session ids away from the missing-session scope', () => {
    expect(sessionLogScopeKey('missing')).toBe('session_id:value:missing');
    expect(sessionLogScopeKey('missing')).not.toBe(MISSING_SESSION_LOG_SCOPE_KEY);
  });
});
