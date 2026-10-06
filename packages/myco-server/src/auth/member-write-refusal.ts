export class MemberWriteRefused extends Error {
  constructor() { super('member no longer holds the write authority'); }
}

/** A known admission refusal remains distinct from a store failure. */
export async function memberWriteOutcome<T>(write: () => Promise<T>): Promise<{ admitted: true; value: T } | { admitted: false }> {
  try { return { admitted: true, value: await write() }; }
  catch (error) {
    if (error instanceof MemberWriteRefused) return { admitted: false };
    throw error;
  }
}
