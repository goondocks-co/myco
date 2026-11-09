/** How much of what a check found is kept: a fixed number of findings of a fixed length, and a count of the rest. */

/** At most this many findings are kept per outcome; the count beyond it is recorded, not the text. */
export const MAX_FINDINGS = 20;
/** At most this many characters of one finding are kept. */
const MAX_FINDING_CHARS = 300;

export interface BoundedFindings { findings: string[]; findingsOmitted: number }

const boundFinding = (finding: string): string => finding.length > MAX_FINDING_CHARS ? `${finding.slice(0, MAX_FINDING_CHARS)}…` : finding;

/** At most `MAX_FINDINGS` findings of at most `MAX_FINDING_CHARS` each; the count beyond is kept as a number. */
export function boundFindings(findings: readonly string[]): BoundedFindings {
  return { findings: findings.slice(0, MAX_FINDINGS).map(boundFinding), findingsOmitted: Math.max(0, findings.length - MAX_FINDINGS) };
}

/** Accumulates findings across a walk, holding no more than an outcome keeps. */
export function findingCollector() {
  const kept: string[] = [];
  let omitted = 0;
  return {
    add(findings: readonly string[]): void {
      const room = MAX_FINDINGS - kept.length;
      kept.push(...findings.slice(0, Math.max(0, room)).map(boundFinding));
      omitted += Math.max(0, findings.length - Math.max(0, room));
    },
    snapshot: (): BoundedFindings => ({ findings: [...kept], findingsOmitted: omitted }),
  };
}
