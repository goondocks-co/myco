export const RELEASE_UNKNOWN_REASONS = [
  'startOnly', 'dirty', 'statusUnreadable', 'commitMissing', 'pathsUnreadable', 'tooManyPaths',
  'commitUnreadable', 'pullUnplaced', 'refsIncomplete',
] as const;
export type ReleaseUnknownReason = (typeof RELEASE_UNKNOWN_REASONS)[number];
export type ReleaseUnknownCounts = Partial<Record<ReleaseUnknownReason, number>>;
