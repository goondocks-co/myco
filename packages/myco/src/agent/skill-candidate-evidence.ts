import type { CandidateQualityFailureCode } from './skill-candidate-quality.js';

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

export interface CandidateEvidenceSpore {
  id: string;
  observation_type?: string | null;
  session_id?: string | null;
  content?: string | null;
  context?: string | null;
  importance?: number | null;
  file_path?: string | null;
  tags?: string | null;
  properties?: string | null;
  created_at?: number | null;
}

export interface CandidateEvidenceSession {
  id: string;
  title?: string | null;
  summary?: string | null;
}

export interface CandidateEvidenceComparable {
  id?: string;
  name?: string;
  topic?: string;
  description?: string;
  rationale?: string;
  status?: string | null;
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

export interface BuildCandidateEvidenceBundlesInput {
  wisdomSpores?: CandidateEvidenceSpore[];
  decisions?: CandidateEvidenceSpore[];
  gotchas?: CandidateEvidenceSpore[];
  sessions?: CandidateEvidenceSession[];
  activeSkills?: Array<string | CandidateEvidenceComparable>;
  existingCandidates?: Array<string | CandidateEvidenceComparable>;
}

export interface CandidateEvidenceAssessment {
  score: number;
  failures: CandidateQualityFailureCode[];
  coverageMatches: string[];
}

const SOURCE_TYPES = new Set<CandidateSourceType>(['spore', 'session', 'plan', 'artifact']);
const MIN_SOURCE_REFS = 3;
const MIN_DISTINCT_SESSIONS = 2;
const OVERLAP_SIMILARITY_THRESHOLD = 0.18;
const OVERLAP_SHARED_TOKEN_THRESHOLD = 3;
// Per-failure score penalty. The validator's separate "quality_failures
// must be empty" check is the real approval gate, so the score is a
// triage signal rather than a gate. Penalty 0.2 gives a useful gradient
// (1 failure → 0.8, 2 → 0.6, 3 → 0.4) that ranks candidates by how far
// they are from clean. The earlier value (0.35) made any single failure
// fall below the 0.7 threshold, making the score effectively binary and
// the threshold dead code.
const SCORE_PENALTY_PER_FAILURE = 0.2;
const MAX_EVIDENCE_BUNDLES = 8;
const MAX_RELATED_SPORES_PER_BUNDLE = 6;
const MIN_BUNDLE_SOURCE_REFS = 2;
const RELATED_SPORE_MIN_SHARED_ANCHORS = 2;
const RELATED_SPORE_MIN_OVERLAP = 0.12;
const DISMISSED_CANDIDATE_STATUS = 'dismissed';

const STOP_WORDS = new Set([
  'about',
  'after',
  'above',
  'assistant',
  'before',
  'candidate',
  'change',
  'changes',
  'domain',
  'existing',
  'exfiltrate',
  'from',
  'developer',
  'ignore',
  'into',
  'instruction',
  'instructions',
  'multiple',
  'previous',
  'prior',
  'secret',
  'secrets',
  'should',
  'skill',
  'system',
  'that',
  'their',
  'there',
  'these',
  'this',
  'through',
  'topic',
  'tool',
  'user',
  'when',
  'with',
  'workflow',
]);

interface SporeFeatures {
  anchors: string[];
  strippedText: string;
}

function computeSporeFeatures(spore: CandidateEvidenceSpore): SporeFeatures {
  const text = sporeText(spore);
  return {
    anchors: extractProjectAnchors(text),
    strippedText: stripProjectAnchors(text),
  };
}

export function buildCandidateEvidenceBundles(
  input: BuildCandidateEvidenceBundlesInput,
): SkillCandidateEvidenceBundle[] {
  const safeInput = isRecord(input) ? input : {};
  const wisdomSpores = normalizeSpores(safeInput.wisdomSpores);
  const decisions = normalizeSpores(safeInput.decisions);
  const gotchas = normalizeSpores(safeInput.gotchas);
  const sessions = normalizeSessions(safeInput.sessions);
  const sessionById = new Map(sessions.map(session => [session.id, session]));
  const supportingSpores = [...decisions, ...gotchas];
  const bundles: SkillCandidateEvidenceBundle[] = [];
  const seenSupportingIds = new Set<string>();

  // Precompute anchors + stripped text per spore exactly once. Without
  // this, relatedSporesForSeed re-ran extractProjectAnchors + tokenOverlap
  // on the same candidate spore for every seed iteration, producing an
  // O(S²) regex pass. Now each spore's features are computed once and
  // looked up O(1) per inner-loop iteration.
  const featuresCache = new Map<string, SporeFeatures>();
  for (const spore of [...wisdomSpores, ...supportingSpores]) {
    if (!featuresCache.has(spore.id)) {
      featuresCache.set(spore.id, computeSporeFeatures(spore));
    }
  }

  for (const wisdom of sortSpores(wisdomSpores)) {
    const relatedSpores = relatedSporesForSeed(wisdom, supportingSpores, featuresCache);
    const bundle = buildBundleFromSeed({
      seed: wisdom,
      relatedSpores,
      sessionById,
      activeSkills: safeInput.activeSkills as BuildCandidateEvidenceBundlesInput['activeSkills'],
      existingCandidates: safeInput.existingCandidates as BuildCandidateEvidenceBundlesInput['existingCandidates'],
      consolidatesWisdom: true,
    });
    if (bundle) {
      bundles.push(bundle);
      for (const related of relatedSpores) seenSupportingIds.add(related.id);
    }
  }

  for (const spore of sortSpores(supportingSpores)) {
    if (seenSupportingIds.has(spore.id)) continue;
    const relatedSpores = relatedSporesForSeed(spore, supportingSpores, featuresCache)
      .filter(related => related.id !== spore.id);
    for (const related of relatedSpores) {
      if (sharedProjectAnchorCount(spore, related, featuresCache) >= RELATED_SPORE_MIN_SHARED_ANCHORS) {
        seenSupportingIds.add(related.id);
      }
    }
    seenSupportingIds.add(spore.id);

    const bundle = buildBundleFromSeed({
      seed: spore,
      relatedSpores,
      sessionById,
      activeSkills: safeInput.activeSkills as BuildCandidateEvidenceBundlesInput['activeSkills'],
      existingCandidates: safeInput.existingCandidates as BuildCandidateEvidenceBundlesInput['existingCandidates'],
      consolidatesWisdom: false,
    });
    if (bundle) bundles.push(bundle);
  }

  return dedupeBundles(bundles)
    .sort(compareBundles)
    .slice(0, MAX_EVIDENCE_BUNDLES);
}

function featuresFor(
  spore: CandidateEvidenceSpore,
  cache: Map<string, SporeFeatures>,
): SporeFeatures {
  const cached = cache.get(spore.id);
  if (cached) return cached;
  const computed = computeSporeFeatures(spore);
  cache.set(spore.id, computed);
  return computed;
}

/**
 * Parses source_ids and returns both the normalized refs and the raw
 * pre-normalization entry count, so callers can detect "input had N
 * entries but only M were valid type/id shapes" without a second
 * JSON.parse pass.
 *
 * `rawCount` is `null` when the value isn't a JSON array (or isn't a
 * string at all) — meaning the field is structurally absent rather
 * than "present but empty".
 */
export function parseSourceRefsWithRawCount(
  value: unknown,
): { refs: CandidateSourceRef[]; rawCount: number | null } {
  const raw = readJsonArray(value);
  if (raw === null) return { refs: [], rawCount: null };
  return { refs: normalizeSourceRefs(raw), rawCount: raw.length };
}

export function parseSourceRefs(value: unknown): CandidateSourceRef[] {
  return parseSourceRefsWithRawCount(value).refs;
}

function readJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function assessCandidateEvidence(input: AssessCandidateEvidenceInput): CandidateEvidenceAssessment {
  const safeInput = isRecord(input) ? input : {};
  const failures: CandidateQualityFailureCode[] = [];
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

  const existingCandidateComparables = partitionExistingCandidateComparables(safeInput.existingCandidates);
  const candidateMatch = bestOverlapMatch(candidateText, existingCandidateComparables.blocking, 'candidate');
  if (candidateMatch) {
    failures.push('existing-candidate-overlap');
    coverageMatches.push(candidateMatch);
  }

  const dismissedCandidateMatch = bestOverlapMatch(
    candidateText,
    existingCandidateComparables.dismissed,
    'dismissed-candidate',
  );
  if (dismissedCandidateMatch) {
    coverageMatches.push(dismissedCandidateMatch);
  }

  return {
    score: Math.max(0, 1 - (failures.length * SCORE_PENALTY_PER_FAILURE)),
    failures,
    coverageMatches,
  };
}

interface BuildBundleFromSeedInput {
  seed: CandidateEvidenceSpore;
  relatedSpores: CandidateEvidenceSpore[];
  sessionById: Map<string, CandidateEvidenceSession>;
  activeSkills?: Array<string | CandidateEvidenceComparable>;
  existingCandidates?: Array<string | CandidateEvidenceComparable>;
  consolidatesWisdom: boolean;
}

function buildBundleFromSeed(input: BuildBundleFromSeedInput): SkillCandidateEvidenceBundle | null {
  const spores = [input.seed, ...input.relatedSpores]
    .filter(spore => spore.id)
    .slice(0, MAX_RELATED_SPORES_PER_BUNDLE);
  const sourceRefs = sourceRefsForSpores(spores);
  if (sourceRefs.length < MIN_BUNDLE_SOURCE_REFS) return null;

  const rationale = bundleRationale(spores, input.sessionById);
  if (!rationale) return null;

  const topic = topicForBundle(input.seed, spores);
  const sourceSessions = sourceRefs
    .filter(ref => ref.type === 'session')
    .map(ref => ref.id);
  const assessment = assessCandidateEvidence({
    topic,
    rationale,
    sourceRefs,
    sourceSessions,
    activeSkills: input.activeSkills,
    existingCandidates: input.existingCandidates,
    consolidatesWisdom: input.consolidatesWisdom,
  });
  if (
    assessment.failures.includes('insufficient-source-refs')
    || assessment.failures.includes('missing-project-anchor')
  ) {
    return null;
  }

  return {
    id: evidenceBundleId(topic, sourceRefs),
    topic,
    score: assessment.score,
    failures: assessment.failures,
    coverageMatches: assessment.coverageMatches,
    sourceRefs,
  };
}

function relatedSporesForSeed(
  seed: CandidateEvidenceSpore,
  candidates: CandidateEvidenceSpore[],
  featuresCache: Map<string, SporeFeatures>,
): CandidateEvidenceSpore[] {
  const seedFeatures = featuresFor(seed, featuresCache);
  if (seedFeatures.anchors.length === 0) return [];

  return candidates
    .filter(candidate => candidate.id !== seed.id)
    .map(candidate => {
      const candidateFeatures = featuresFor(candidate, featuresCache);
      const sharedAnchors = sharedAnchorCount(seedFeatures.anchors, candidateFeatures.anchors);
      const overlap = tokenOverlap(seedFeatures.strippedText, candidateFeatures.strippedText);
      return { candidate, sharedAnchors, overlap: overlap.score };
    })
    .filter(item => (
      item.sharedAnchors >= RELATED_SPORE_MIN_SHARED_ANCHORS
      || item.overlap >= RELATED_SPORE_MIN_OVERLAP
    ))
    .sort((a, b) => {
      if (b.sharedAnchors !== a.sharedAnchors) return b.sharedAnchors - a.sharedAnchors;
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return compareSpores(a.candidate, b.candidate);
    })
    .map(item => item.candidate);
}

function sharedProjectAnchorCount(
  a: CandidateEvidenceSpore,
  b: CandidateEvidenceSpore,
  featuresCache: Map<string, SporeFeatures>,
): number {
  return sharedAnchorCount(
    featuresFor(a, featuresCache).anchors,
    featuresFor(b, featuresCache).anchors,
  );
}

function sharedAnchorCount(a: string[], b: string[]): number {
  const aKeys = anchorComparisonKeys(a);
  const bKeys = anchorComparisonKeys(b);
  return bKeys.filter(anchor => aKeys.includes(anchor)).length;
}

function anchorComparisonKeys(anchors: string[]): string[] {
  const fullPaths = anchors.filter(anchor => anchor.includes('/'));
  return uniqueStrings(anchors.filter(anchor => {
    if (!isBareFileAnchor(anchor)) return true;
    return !fullPaths.some(pathAnchor => pathAnchor.endsWith(`/${anchor}`));
  }));
}

function isBareFileAnchor(anchor: string): boolean {
  return /^[a-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|md|yaml|yml|json|sql|sh)$/i.test(anchor);
}

function sourceRefsForSpores(spores: CandidateEvidenceSpore[]): CandidateSourceRef[] {
  const refs: CandidateSourceRef[] = [];
  for (const spore of spores) {
    refs.push({ id: spore.id, type: 'spore' });
    for (const sourceId of consolidatedFrom(spore)) {
      refs.push({ id: sourceId, type: 'spore' });
    }
    if (spore.session_id) {
      refs.push({ id: spore.session_id, type: 'session' });
    }
  }
  return normalizeSourceRefs(refs);
}

function bundleRationale(
  spores: CandidateEvidenceSpore[],
  sessionById: Map<string, CandidateEvidenceSession>,
): string {
  const parts: string[] = [];
  for (const spore of spores) {
    const text = truncateText(sporeText(spore), 220);
    if (text) parts.push(text);
  }
  const sessionIds = new Set(spores.map(spore => spore.session_id).filter(Boolean) as string[]);
  for (const sessionId of sessionIds) {
    const session = sessionById.get(sessionId);
    const sessionText = [session?.title, session?.summary].map(value => safeString(value)).filter(Boolean).join(' ');
    if (sessionText) parts.push(truncateText(sessionText, 180));
  }
  return parts.join(' ');
}

function topicForBundle(seed: CandidateEvidenceSpore, spores: CandidateEvidenceSpore[]): string {
  const anchorTokens = extractProjectAnchors(spores.map(sporeText).join(' '))
    .flatMap(anchor => [...normalizedTokens(anchor)])
    .filter(token => !STOP_WORDS.has(token));
  const textTokens = [...normalizedTokens(sporeText(seed))]
    .filter(token => !STOP_WORDS.has(token));
  const tokens = uniqueStrings([...textTokens, ...anchorTokens])
    .filter(token => !/^\d+$/.test(token))
    .slice(0, 5);
  return tokens.length > 0 ? tokens.join(' ') : seed.id;
}

export function extractProjectAnchors(text: string): string[] {
  const anchors: string[] = [];
  const addMatches = (pattern: RegExp, source: string) => {
    for (const match of source.matchAll(pattern)) {
      anchors.push(normalizeAnchor(match[1] ?? match[0]));
    }
  };

  addMatches(/`([^`]+)`/g, text);
  addMatches(/\b((?:[a-z0-9_.-]+\/){1,}[a-z0-9_.-]+)\b/gi, text);
  addMatches(/\b([a-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|md|yaml|yml|json|sql|sh))\b/gi, text);
  addMatches(/\b((?:make|bun|npm|pnpm|node|myco(?:-dev)?)\s+[a-z0-9:_./-]+)\b/gi, text);
  addMatches(/\b(AGENTS\.md|ProjectScope|GroveProjectId|PowerManager|SKILL\.md|\.myco|vault_[a-z_]+)\b/g, text);

  return uniqueStrings(anchors.filter(anchor => anchor && hasProjectAnchor(anchor))).slice(0, 12);
}

function evidenceBundleId(topic: string, sourceRefs: CandidateSourceRef[]): string {
  const seed = sourceRefs.find(ref => ref.type === 'spore')?.id ?? topic;
  return `candidate-evidence-${slugify(topic)}-${slugify(seed).slice(0, 32)}`;
}

function dedupeBundles(bundles: SkillCandidateEvidenceBundle[]): SkillCandidateEvidenceBundle[] {
  const byKey = new Map<string, SkillCandidateEvidenceBundle>();
  for (const bundle of bundles) {
    const sporeRefs = bundle.sourceRefs
      .filter(ref => ref.type === 'spore')
      .map(ref => ref.id)
      .sort()
      .join('|');
    const key = `${bundle.topic}:${sporeRefs}`;
    const existing = byKey.get(key);
    if (!existing || compareBundles(bundle, existing) < 0) {
      byKey.set(key, bundle);
    }
  }
  return [...byKey.values()];
}

function compareBundles(a: SkillCandidateEvidenceBundle, b: SkillCandidateEvidenceBundle): number {
  if (b.score !== a.score) return b.score - a.score;
  const topicOrder = a.topic.localeCompare(b.topic);
  if (topicOrder !== 0) return topicOrder;
  return a.id.localeCompare(b.id);
}

function normalizeSpores(value: unknown): CandidateEvidenceSpore[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map(row => ({
      id: safeString(row.id),
      observation_type: safeString(row.observation_type),
      session_id: safeString(row.session_id) || null,
      content: safeString(row.content),
      context: safeString(row.context) || null,
      importance: typeof row.importance === 'number' ? row.importance : null,
      file_path: safeString(row.file_path) || null,
      tags: safeString(row.tags) || null,
      properties: safeString(row.properties) || null,
      created_at: typeof row.created_at === 'number' ? row.created_at : null,
    }))
    .filter(spore => spore.id && spore.content);
}

function normalizeSessions(value: unknown): CandidateEvidenceSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map(row => ({
      id: safeString(row.id),
      title: safeString(row.title) || null,
      summary: safeString(row.summary) || null,
    }))
    .filter(session => session.id);
}

function sortSpores(spores: CandidateEvidenceSpore[]): CandidateEvidenceSpore[] {
  return [...spores].sort(compareSpores);
}

function compareSpores(a: CandidateEvidenceSpore, b: CandidateEvidenceSpore): number {
  const importanceOrder = (b.importance ?? 0) - (a.importance ?? 0);
  if (importanceOrder !== 0) return importanceOrder;
  const createdOrder = (b.created_at ?? 0) - (a.created_at ?? 0);
  if (createdOrder !== 0) return createdOrder;
  return a.id.localeCompare(b.id);
}

function sporeText(spore: CandidateEvidenceSpore): string {
  return [spore.content, spore.context, spore.file_path, spore.tags]
    .map(value => safeString(value))
    .filter(Boolean)
    .join(' ');
}

function consolidatedFrom(spore: CandidateEvidenceSpore): string[] {
  if (!spore.properties) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(spore.properties);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.consolidated_from)) return [];
  return parsed.consolidated_from.map(value => safeString(value)).filter(Boolean);
}

function normalizeAnchor(anchor: string): string {
  return anchor.trim().replace(/[.,;:)]+$/g, '').toLowerCase();
}

function stripProjectAnchors(text: string): string {
  return text
    .replace(/`[^`]+`/g, ' ')
    .replace(/\b((?:[a-z0-9_.-]+\/){1,}[a-z0-9_.-]+)\b/gi, ' ')
    .replace(/\b[a-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|md|yaml|yml|json|sql|sh)\b/gi, ' ')
    .replace(/\b(?:make|bun|npm|pnpm|node|myco(?:-dev)?)\s+[a-z0-9:_./-]+\b/gi, ' ')
    .replace(/\b(?:AGENTS\.md|ProjectScope|GroveProjectId|PowerManager|SKILL\.md|\.myco|vault_[a-z_]+)\b/gi, ' ');
}

function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function truncateText(value: string, maxLength: number): string {
  const clean = value.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
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
    ? sourceRefs.map(ref => `${ref.type}:${promptSafeScalar(ref.id, 'unknown')}`).join(', ')
    : 'none';
  const id = promptSafeScalar(safeBundle.id, 'unknown');
  const topic = promptSafeScalar(safeBundle.topic, 'unknown');

  return [
    `#### ${id}`,
    `- topic: ${topic}`,
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

  for (const bundle of safeBundles) {
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
    /\b(?:AGENTS\.md|ProjectScope|GroveProjectId|PowerManager|SKILL\.md|\.myco|vault_[a-z_]+)\b/i,
  ].some(pattern => pattern.test(text));
}

function partitionExistingCandidateComparables(value: unknown): { blocking: unknown[]; dismissed: unknown[] } {
  const result: { blocking: unknown[]; dismissed: unknown[] } = { blocking: [], dismissed: [] };
  if (!Array.isArray(value)) return result;

  for (const comparable of value) {
    if (
      isRecord(comparable)
      && safeString(comparable.status).toLowerCase() === DISMISSED_CANDIDATE_STATUS
    ) {
      result.dismissed.push(comparable);
    } else {
      result.blocking.push(comparable);
    }
  }

  return result;
}

function bestOverlapMatch(
  candidateText: string,
  comparables: unknown,
  prefix: 'active-skill' | 'candidate' | 'dismissed-candidate',
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
  // Always two decimal places. The earlier integer/non-integer split
  // produced "1.00" for 1.0 but "0.7" for 0.7, an inconsistency visible
  // in the prompts shown to the model.
  return score.toFixed(2);
}

function promptSafeScalar(value: unknown, fallback: string): string {
  let clean = safeString(value, fallback)
    .replace(/\s+/g, ' ')
    .replace(/[`<>]/g, '')
    .trim();
  if (!clean) clean = fallback;

  clean = clean
    .replace(/\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?\b/gi, '[redacted]')
    .replace(/\b(?:system|developer|assistant|user|tool)\s*:/gi, '[redacted]:')
    .replace(/\/(?:system|developer|assistant|user|tool)\b/gi, '/[redacted]');

  return truncateText(clean, 140);
}
