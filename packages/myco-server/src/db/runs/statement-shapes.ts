import type { LeaseHolder } from '../../core/worker-lease.js';

/** One definition per statement shape, made the first time that shape is asked for; the shape names it. */
export function shapedStatements<Definition>(): (shape: string, define: (shape: string) => Definition) => Definition {
  const held = new Map<string, Definition>();
  return (shape, define) => {
    const known = held.get(shape);
    if (known !== undefined) return known;
    const made = define(shape);
    held.set(shape, made);
    return made;
  };
}

/** The lease authority's SQL varies only by who holds the lease and whether the attempt is named. */
export const leaseShape = (worker: LeaseHolder, attemptId: string | null | undefined): string =>
  `${worker.kind === 'member' ? 'Member' : 'Runner'}${attemptId === undefined ? '' : 'Attempt'}`;
