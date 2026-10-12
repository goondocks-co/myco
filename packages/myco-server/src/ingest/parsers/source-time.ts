/** Transcript formats whose ordering timestamps are synthetic rather than recorded instants. */
const UNDATED_FORMATS: ReadonlySet<string> = new Set(['cursor']);

export function sourceTimestampsRecorded(agent: string | null): boolean {
  return agent === null || !UNDATED_FORMATS.has(agent);
}
