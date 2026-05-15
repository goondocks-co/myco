export type CandidateSourceType = 'spore' | 'session' | 'plan' | 'artifact';

export interface CandidateSourceRef {
  id: string;
  type: CandidateSourceType;
}

export interface SkillCandidateEvidenceBundle {
  id: string;
  topic: string;
  score: number;
  failures: string[];
  coverageMatches: string[];
  sourceRefs: CandidateSourceRef[];
}

export interface CandidateEvidenceComparable {
  id?: string;
  name?: string;
  topic?: string;
  description?: string;
  rationale?: string;
}

export interface AssessCandidateEvidenceInput {
  topic?: string;
  rationale?: string;
  sourceRefs?: CandidateSourceRef[];
  sourceSessions?: Array<string | { id?: string | null } | null | undefined>;
  activeSkills?: Array<string | CandidateEvidenceComparable>;
  existingCandidates?: Array<string | CandidateEvidenceComparable>;
  consolidatesWisdom?: boolean;
}

export interface CandidateEvidenceAssessment {
  score: number;
  failures: string[];
  coverageMatches: string[];
}

const SOURCE_TYPES = new Set<CandidateSourceType>(['spore', 'session', 'plan', 'artifact']);
const MIN_SOURCE_REFS = 3;
const MIN_DISTINCT_SESSIONS = 2;
const OVERLAP_SIMILARITY_THRESHOLD = 0.18;
const OVERLAP_SHARED_TOKEN_THRESHOLD = 3;
const SCORE_PENALTY_PER_FAILURE = 0.2;

const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'candidate',
  'change',
  'changes',
  'existing',
  'from',
  'into',
  'multiple',
  'should',
  'skill',
  'that',
  'their',
  'there',
  'these',
  'this',
  'topic',
  'when',
  'with',
  'workflow',
]);

export function parseSourceRefs(value: unknown): CandidateSourceRef[] {
  if (typeof value !== 'string') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const refs: CandidateSourceRef[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== 'string') continue;
    if (typeof candidate.type !== 'string') continue;
    if (!SOURCE_TYPES.has(candidate.type as CandidateSourceType)) continue;
    refs.push({ id: candidate.id, type: candidate.type as CandidateSourceType });
  }
  return refs;
}

export function assessCandidateEvidence(input: AssessCandidateEvidenceInput): CandidateEvidenceAssessment {
  const failures: string[] = [];
  const coverageMatches: string[] = [];
  const sourceRefs = input.sourceRefs ?? [];

  if (sourceRefs.length < MIN_SOURCE_REFS) {
    failures.push('insufficient-source-refs');
  }

  const sessionIds = distinctSessionIds(sourceRefs, input.sourceSessions ?? []);
  if (!input.consolidatesWisdom && sessionIds.size < MIN_DISTINCT_SESSIONS) {
    failures.push('insufficient-distinct-sessions');
  }

  const candidateText = [input.topic, input.rationale].filter(Boolean).join(' ');
  if (!hasProjectAnchor(candidateText)) {
    failures.push('missing-project-anchor');
  }

  const activeSkillMatch = bestOverlapMatch(candidateText, input.activeSkills ?? [], 'active-skill');
  if (activeSkillMatch) {
    failures.push('active-skill-overlap');
    coverageMatches.push(activeSkillMatch);
  }

  const candidateMatch = bestOverlapMatch(candidateText, input.existingCandidates ?? [], 'candidate');
  if (candidateMatch) {
    failures.push('existing-candidate-overlap');
    coverageMatches.push(candidateMatch);
  }

  return {
    score: Math.max(0, 1 - (failures.length * SCORE_PENALTY_PER_FAILURE)),
    failures,
    coverageMatches,
  };
}

export function renderEvidenceBundleForPrompt(bundle: SkillCandidateEvidenceBundle): string {
  const failures = bundle.failures.length > 0 ? bundle.failures.join(', ') : 'none';
  const coverageMatches = bundle.coverageMatches.length > 0 ? bundle.coverageMatches.join(', ') : 'none';
  const sourceRefs = bundle.sourceRefs.length > 0
    ? bundle.sourceRefs.map(ref => `${ref.type}:${ref.id}`).join(', ')
    : 'none';

  return [
    `#### ${bundle.id}: ${bundle.topic}`,
    `- score: ${formatScore(bundle.score)}`,
    `- failures: ${failures}`,
    `- coverage_matches: ${coverageMatches}`,
    `- source_refs: ${sourceRefs}`,
  ].join('\n');
}

export function renderEvidenceBundlesForPrompt(bundles: SkillCandidateEvidenceBundle[]): string {
  const parts = [`### Candidate Evidence Bundles (${bundles.length})`];
  if (bundles.length === 0) {
    parts.push('No candidate evidence bundles assembled yet.');
    return parts.join('\n');
  }

  for (const bundle of [...bundles].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push('', renderEvidenceBundleForPrompt(bundle));
  }
  return parts.join('\n');
}

function distinctSessionIds(
  sourceRefs: CandidateSourceRef[],
  sourceSessions: Array<string | { id?: string | null } | null | undefined>,
): Set<string> {
  const ids = new Set<string>();
  for (const ref of sourceRefs) {
    if (ref.type === 'session') ids.add(ref.id);
  }
  for (const session of sourceSessions) {
    if (typeof session === 'string') {
      ids.add(session);
    } else if (session?.id) {
      ids.add(session.id);
    }
  }
  return ids;
}

function hasProjectAnchor(text: string): boolean {
  return [
    /`[^`]*(?:\/|\.ts\b|\.tsx\b|\.js\b|\.md\b|make\s+|node\s+|bun\s+|myco(?:-dev)?\s+)[^`]*`/i,
    /\b(?:[a-z0-9_.-]+\/){1,}[a-z0-9_.-]+\b/i,
    /\b[a-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|md|yaml|yml|json|sql|sh)\b/i,
    /\b(?:make|bun|npm|pnpm|node|myco(?:-dev)?)\s+[a-z0-9:_./-]+\b/i,
    /\b(?:AGENTS\.md|ProjectScope|GroveProjectId|PowerManager|SKILL\.md|\.myco|vault_[a-z_]+)\b/,
  ].some(pattern => pattern.test(text));
}

function bestOverlapMatch(
  candidateText: string,
  comparables: Array<string | CandidateEvidenceComparable>,
  prefix: 'active-skill' | 'candidate',
): string | null {
  let best: { id: string; score: number; shared: number } | null = null;
  for (const comparable of comparables) {
    const { id, text } = comparableText(comparable);
    const overlap = tokenOverlap(candidateText, text);
    if (
      overlap.shared >= OVERLAP_SHARED_TOKEN_THRESHOLD
      && overlap.score >= OVERLAP_SIMILARITY_THRESHOLD
      && (!best || overlap.score > best.score || (overlap.score === best.score && id.localeCompare(best.id) < 0))
    ) {
      best = { id, score: overlap.score, shared: overlap.shared };
    }
  }

  return best ? `${prefix}:${best.id}` : null;
}

function comparableText(value: string | CandidateEvidenceComparable): { id: string; text: string } {
  if (typeof value === 'string') return { id: value, text: value };
  const id = value.id ?? value.name ?? value.topic ?? 'unknown';
  return {
    id,
    text: [value.name, value.topic, value.description, value.rationale].filter(Boolean).join(' '),
  };
}

function tokenOverlap(a: string, b: string): { score: number; shared: number } {
  const aTokens = normalizedTokens(a);
  const bTokens = normalizedTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return { score: 0, shared: 0 };

  let shared = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) shared++;
  }

  const union = new Set([...aTokens, ...bTokens]);
  return { score: shared / union.size, shared };
}

function normalizedTokens(text: string): Set<string> {
  return new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3)
    .map(normalizeToken)
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token)));
}

function normalizeToken(token: string): string {
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? score.toFixed(2) : score.toFixed(2).replace(/0$/, '');
}
