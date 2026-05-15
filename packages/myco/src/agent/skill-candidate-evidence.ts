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
const SCORE_PENALTY_PER_FAILURE = 0.35;

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
  if (Array.isArray(value)) return normalizeSourceRefs(value);
  if (typeof value !== 'string') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return normalizeSourceRefs(parsed);
}

export function assessCandidateEvidence(input: AssessCandidateEvidenceInput): CandidateEvidenceAssessment {
  const safeInput = isRecord(input) ? input : {};
  const failures: string[] = [];
  const coverageMatches: string[] = [];
  const sourceRefs = normalizeSourceRefs(safeInput.sourceRefs);

  if (sourceRefs.length < MIN_SOURCE_REFS) {
    failures.push('insufficient-source-refs');
  }

  const sessionIds = distinctSessionIds(sourceRefs, safeInput.sourceSessions);
  if (!safeInput.consolidatesWisdom && sessionIds.size < MIN_DISTINCT_SESSIONS) {
    failures.push('insufficient-distinct-sessions');
  }

  const candidateText = [safeString(safeInput.topic), safeString(safeInput.rationale)].filter(Boolean).join(' ');
  if (!hasProjectAnchor(candidateText)) {
    failures.push('missing-project-anchor');
  }

  const activeSkillMatch = bestOverlapMatch(candidateText, safeInput.activeSkills, 'active-skill');
  if (activeSkillMatch) {
    failures.push('active-skill-overlap');
    coverageMatches.push(activeSkillMatch);
  }

  const candidateMatch = bestOverlapMatch(candidateText, safeInput.existingCandidates, 'candidate');
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

function normalizeSourceRefs(value: unknown): CandidateSourceRef[] {
  if (!Array.isArray(value)) return [];

  const refs: CandidateSourceRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const ref = sourceRefFromEntry(entry);
    if (!ref) continue;
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function sourceRefFromEntry(entry: unknown): CandidateSourceRef | null {
  if (typeof entry === 'string') {
    const id = cleanId(entry);
    const type = inferSourceType(id);
    return type ? { id, type } : null;
  }

  if (!isRecord(entry)) return null;
  const id = cleanId(entry.id);
  if (!id || typeof entry.type !== 'string') return null;
  if (!SOURCE_TYPES.has(entry.type as CandidateSourceType)) return null;
  return { id, type: entry.type as CandidateSourceType };
}

function inferSourceType(id: string): CandidateSourceType | null {
  if (/^spore-/i.test(id)) return 'spore';
  if (/^(?:session-|sess-)/i.test(id)) return 'session';
  if (/^plan-/i.test(id)) return 'plan';
  if (/^artifact-/i.test(id)) return 'artifact';
  return null;
}

export function renderEvidenceBundleForPrompt(bundle: SkillCandidateEvidenceBundle): string {
  const safeBundle: Record<string, unknown> = isRecord(bundle) ? bundle : {};
  const failures = cleanStringArray(safeBundle.failures);
  const coverageMatches = cleanStringArray(safeBundle.coverageMatches);
  const sourceRefs = normalizeSourceRefs(safeBundle.sourceRefs);
  const renderedFailures = failures.length > 0 ? failures.join(', ') : 'none';
  const renderedCoverageMatches = coverageMatches.length > 0 ? coverageMatches.join(', ') : 'none';
  const renderedSourceRefs = sourceRefs.length > 0
    ? sourceRefs.map(ref => `${ref.type}:${ref.id}`).join(', ')
    : 'none';

  return [
    `#### ${safeString(safeBundle.id, 'unknown')}: ${safeString(safeBundle.topic, 'unknown')}`,
    `- score: ${formatScore(safeBundle.score)}`,
    `- failures: ${renderedFailures}`,
    `- coverage_matches: ${renderedCoverageMatches}`,
    `- source_refs: ${renderedSourceRefs}`,
  ].join('\n');
}

export function renderEvidenceBundlesForPrompt(bundles: SkillCandidateEvidenceBundle[]): string {
  const safeBundles = Array.isArray(bundles)
    ? bundles.filter(isRecord) as unknown as SkillCandidateEvidenceBundle[]
    : [];
  const parts = [`### Candidate Evidence Bundles (${safeBundles.length})`];
  if (safeBundles.length === 0) return parts.join('\n');

  for (const bundle of [...safeBundles].sort((a, b) => safeString(a.id).localeCompare(safeString(b.id)))) {
    parts.push('', renderEvidenceBundleForPrompt(bundle));
  }
  return parts.join('\n');
}

function distinctSessionIds(
  sourceRefs: CandidateSourceRef[],
  sourceSessions: unknown,
): Set<string> {
  const ids = new Set<string>();
  for (const ref of sourceRefs) {
    if (ref.type === 'session') ids.add(ref.id);
  }
  if (!Array.isArray(sourceSessions)) return ids;
  for (const session of sourceSessions) {
    if (typeof session === 'string') {
      const id = cleanId(session);
      if (id) ids.add(id);
    } else if (isRecord(session)) {
      const id = cleanId(session.id);
      if (id) ids.add(id);
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
  comparables: unknown,
  prefix: 'active-skill' | 'candidate',
): string | null {
  if (!Array.isArray(comparables)) return null;

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
  if (!isRecord(value)) return { id: 'unknown', text: '' };
  const id = safeString(value.id, safeString(value.name, safeString(value.topic, 'unknown')));
  return {
    id,
    text: [value.name, value.topic, value.description, value.rationale].map(value => safeString(value)).filter(Boolean).join(' '),
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

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => safeString(item)).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function formatScore(score: unknown): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return '0.00';
  return Number.isInteger(score) ? score.toFixed(2) : score.toFixed(2).replace(/0$/, '');
}
