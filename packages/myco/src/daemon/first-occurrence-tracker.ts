/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export const DEFAULT_FIRST_OCCURRENCE_TRACKER_MAX_KEYS = 1024;
export const MISSING_SESSION_LOG_SCOPE_KEY = 'session_id:missing';
const SESSION_LOG_SCOPE_VALUE_PREFIX = 'session_id:value:';

export type OccurrenceDecision = 'first' | 'repeat';

export interface FirstOccurrenceTracker {
  mark(key: string): OccurrenceDecision;
  clear(): void;
  readonly size: number;
}

export function sessionLogScopeKey(sessionId: string | undefined): string {
  return sessionId === undefined
    ? MISSING_SESSION_LOG_SCOPE_KEY
    : `${SESSION_LOG_SCOPE_VALUE_PREFIX}${sessionId}`;
}

export function createBoundedFirstOccurrenceTracker(options: {
  maxKeys?: number;
} = {}): FirstOccurrenceTracker {
  const maxKeys = options.maxKeys ?? DEFAULT_FIRST_OCCURRENCE_TRACKER_MAX_KEYS;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new Error('FirstOccurrenceTracker maxKeys must be a positive integer');
  }

  const seen = new Set<string>();

  return {
    mark(key: string): OccurrenceDecision {
      if (seen.has(key)) return 'repeat';
      if (seen.size >= maxKeys) seen.clear();
      seen.add(key);
      return 'first';
    },
    clear(): void {
      seen.clear();
    },
    get size(): number {
      return seen.size;
    },
  };
}
