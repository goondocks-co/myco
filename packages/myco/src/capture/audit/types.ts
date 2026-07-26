/**
 * Capture fidelity audit — shared types.
 *
 * The audit compares three layers: the raw transcript on disk (what the agent
 * did), the package's capture policy applied to it (what should have been
 * captured), and the vault rows (what was). A gap between the first two is
 * drift — the agent changed and a manifest or parser no longer matches it. A
 * gap between the last two is a pipeline failure. They look identical in the
 * database and have unrelated fixes, so findings name which one they are.
 */

/** Which of the two comparisons a finding came from. */
export type FindingLayer = 'drift' | 'pipeline' | 'integrity';

export type Severity = 'high' | 'medium' | 'low';

/**
 * Whether the class is still happening.
 *
 * A backlog that stopped accruing is bounded cleanup; one still accruing means
 * repairing rows would mask an open bug. This changes what a human is being
 * asked to approve, so it is derived for every finding rather than inferred at
 * reading time.
 */
export type Recency = 'active' | 'legacy' | 'unknown';

export interface Finding {
  /** Stable class id, e.g. `batch-null-content-hash`. Referenced by findings.md. */
  id: string;
  layer: FindingLayer;
  severity: Severity;
  title: string;
  /** Rows or files implicated. */
  count: number;
  recency: Recency;
  firstSeen?: number;
  lastSeen?: number;
  /** The symbiont this concerns, when it is agent-specific. */
  symbiont?: string;
  /** A handful of identifiers so a human can go look. */
  samples: string[];
  /** What was measured, in one or two sentences. */
  detail: string;
}

/**
 * A place the audit deliberately did NOT look, or could not conclude.
 *
 * Reported as prominently as findings: an audit that silently skips a symbiont
 * reads as "clean" for that symbiont, which is worse than saying nothing.
 */
export interface CoverageGap {
  symbiont?: string;
  scope: string;
  reason: string;
}

/** How this agent's data reaches the vault. Derived, never declared twice. */
export type CaptureModel = 'hook-and-mining' | 'plugin-reported';

export interface SymbiontContext {
  name: string;
  model: CaptureModel;
  /** Present only for hook-and-mining agents that declare a layout. */
  hasDiscovery: boolean;
  /** Whether a transcript can be attributed to a project. */
  canAttributeProject: boolean;
}

export interface AuditOptions {
  /** Path to the grove's myco.db. */
  dbPath: string;
  /** Restrict to one project; omit to audit the whole grove. */
  projectId?: string;
  /** Restrict to one symbiont. */
  symbiont?: string;
  /** Lower bound on `created_at`, epoch seconds. */
  since?: number;
  /** Max transcripts enumerated per symbiont. */
  transcriptLimit?: number;
}

export interface AuditReport {
  dbPath: string;
  projectId?: string;
  since?: number;
  generatedAt: number;
  symbionts: SymbiontContext[];
  findings: Finding[];
  coverage: CoverageGap[];
}
