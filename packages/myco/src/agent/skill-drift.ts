import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

export interface SkillDriftInput {
  id: string;
  name: string;
  description: string;
  path: string;
  properties: string;
}

export interface SkillFileFingerprint {
  exports: string[];
}

type ClaimKind = 'path' | 'symbol' | 'skip';

export interface ExtractedClaim {
  token: string;
  kind: ClaimKind;
}

export interface SkillDriftReport {
  skillId: string;
  name: string;
  severity: 'none' | 'minor' | 'major' | 'critical';
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  loadBearingMisses: string[];
  inconclusive: string[];
  growth: string[];
  /**
   * Distinctive symbols inside ```code``` examples that are absent from the
   * codebase — suspected fabrication the normal claim scan cannot see (it
   * strips fences). These are NOT auto-classified STALE because illustrative
   * pseudo-code can use invented names; the assess phase must verify each and
   * treat confirmed-absent symbols as fabrication, not cosmetic drift.
   */
  fabricationSuspects: string[];
  currentFingerprints: Record<string, SkillFileFingerprint>;
}

export interface SkillDriftResult {
  verifiedAt: number;
  reports: SkillDriftReport[];
  totalMissing: number;
  totalInconclusive: number;
  totalGrowth: number;
  totalFabricationSuspects: number;
}

const CLAIM_DENYLIST = new Set([
  'AbortController',
  'Promise',
  'fetch',
  'Config',
  'Error',
  'Map',
  'Set',
  'Object',
  'Array',
]);

const SEARCHABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.kt', '.rs',
  '.php', '.cs', '.cpp', '.c', '.h', '.swift',
  '.scala', '.lua', '.sh', '.sql', '.yaml', '.yml',
  '.json', '.toml', '.md',
]);

// Extensions that count as real source when verifying a symbol exists.
// Narrower than SEARCHABLE_EXTENSIONS: excludes docs/config (.md/.yaml/.json)
// so a symbol that appears only in prose/markdown is not treated as defined.
const SYMBOL_SEARCH_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.kt', '.rs',
  '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.scala', '.lua', '.sh',
]);

// Skill markdown lives here; never count it as evidence a symbol exists.
const SKILL_DOC_PATH_REGEX = /[\\/]\.agents[\\/]skills[\\/]/;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
]);

const CONTAINS_PARENS_REGEX = /[()]/;
const GENERIC_SLASH_WORD_REGEX = /^[a-z]+\/[a-z]+$/i;
const DOT_TOKEN_REGEX = /^\.[A-Za-z_][A-Za-z0-9_]*$/;
const DOT_METHOD_CALL_REGEX = /\.[A-Za-z_][A-Za-z0-9_]*\(\)$/;
const KNOWN_METHOD_SUFFIX_REGEX = /\.(default|min|max|refine)$/;
const PATH_SEGMENT_ALLOWED_CHARS_REGEX = /^[A-Za-z0-9._\-\/]+$/;
const FILELIKE_EXTENSION_REGEX = /\.[A-Za-z0-9]{1,8}$/;
const SYMBOL_TOKEN_REGEX = /^[A-Za-z_][A-Za-z0-9_]*\(\)?$/;
const UPPER_CAMELISH_REGEX = /[A-Z].*[A-Z]/;
const NON_ALNUM_SPACE_REGEX = /[^a-z0-9\s]/g;
const FRONTMATTER_REGEX = /^---[\s\S]*?---\n/;
const TRIPLE_BACKTICK_BLOCK_REGEX = /```[\s\S]*?```/g;
const TRIPLE_TILDE_BLOCK_REGEX = /~~~[\s\S]*?~~~/g;
const BACKTICK_TOKEN_REGEX = /`([^`\n]+)`/g;

function stripFrontmatterAndCodeBlocks(content: string): string {
  const body = content.replace(FRONTMATTER_REGEX, '');
  return body
    .replace(TRIPLE_BACKTICK_BLOCK_REGEX, '')
    .replace(TRIPLE_TILDE_BLOCK_REGEX, '');
}

function isPathToken(token: string): boolean {
  if (CONTAINS_PARENS_REGEX.test(token)) return false;
  if (GENERIC_SLASH_WORD_REGEX.test(token)) return false;
  if (token.startsWith('.') && !token.startsWith('./') && !token.startsWith('../')) {
    return false;
  }
  if (DOT_TOKEN_REGEX.test(token)) return false;
  if (DOT_METHOD_CALL_REGEX.test(token)) return false;
  if (KNOWN_METHOD_SUFFIX_REGEX.test(token)) return false;
  if (token.includes('/')) {
    const segments = token.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    return PATH_SEGMENT_ALLOWED_CHARS_REGEX.test(token);
  }
  return FILELIKE_EXTENSION_REGEX.test(token);
}

function isDistinctiveSymbol(token: string): boolean {
  if (token.length < 5) return false;
  if (token.endsWith('()')) return true;
  if (token.includes('_')) return true;
  return UPPER_CAMELISH_REGEX.test(token);
}

function classifyToken(token: string): ClaimKind {
  if (token.includes(' ') || token.includes('\n')) return 'skip';
  if (isPathToken(token)) return 'path';
  if (!SYMBOL_TOKEN_REGEX.test(token)) return 'skip';
  if (CLAIM_DENYLIST.has(token.replace(/\(\)$/, ''))) return 'skip';
  return 'symbol';
}

export function extractClaims(content: string): ExtractedClaim[] {
  const body = stripFrontmatterAndCodeBlocks(content);
  const seen = new Set<string>();
  const claims: ExtractedClaim[] = [];
  for (const match of body.matchAll(BACKTICK_TOKEN_REGEX)) {
    const token = (match[1] ?? '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      claims.push({ token, kind: classifyToken(token) });
    }
  }
  return claims;
}

// Tokens that look like calls/consts inside fences but are language constructs
// or near-universal globals, not codebase references. Kept separate from the
// inline CLAIM_DENYLIST because the fence scan sees raw source, not prose.
const FENCED_KEYWORD_DENYLIST = new Set([
  'function', 'return', 'await', 'typeof', 'instanceof', 'switch', 'catch',
  'while', 'super', 'delete', 'throw', 'yield', 'async', 'const', 'require',
  'import', 'export', 'default', 'extends', 'implements', 'interface',
  'console', 'process', 'JSON', 'Boolean', 'Number', 'String', 'Symbol',
]);

const FENCED_CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]{4,})\s*\(/g;
const SCREAMING_SNAKE_REGEX = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
const CAMEL_HUMP_REGEX = /[a-z][A-Z]/;

/**
 * Whether a fenced function-call identifier looks like a real API reference
 * (worth verifying) rather than a throwaway local. The trailing `(` already
 * proves it is invoked; we additionally require a camelCase hump or an
 * underscore so single-word locals (`run(`, `next(`) are ignored. Note this is
 * intentionally laxer than `isDistinctiveSymbol` (which demands two capitals)
 * because real APIs like `encodeInjection` have only one.
 */
function looksLikeFencedApiCall(token: string): boolean {
  if (token.length < 6) return false;
  if (token.includes('_')) return true;
  return CAMEL_HUMP_REGEX.test(token);
}

/**
 * Extract distinctive symbols that live INSIDE fenced code blocks and look like
 * real API references — function-call identifiers (`name(`) and
 * SCREAMING_SNAKE_CASE constants/env vars. The normal claim extractor strips
 * fences entirely (to avoid flagging illustrative code), which is exactly the
 * blind spot a fabricated example exploits: invented functions and env vars
 * hide in ```code``` blocks. We deliberately ignore ordinary local variables —
 * only the shapes fabrication tends to take are returned, keeping false
 * positives on legitimate pseudo-code low.
 */
export function extractFencedSymbols(content: string): string[] {
  const body = content.replace(FRONTMATTER_REGEX, '');
  const blocks = [
    ...(body.match(TRIPLE_BACKTICK_BLOCK_REGEX) ?? []),
    ...(body.match(TRIPLE_TILDE_BLOCK_REGEX) ?? []),
  ];
  const out = new Set<string>();
  for (const block of blocks) {
    for (const match of block.matchAll(FENCED_CALL_REGEX)) {
      const token = match[1] ?? '';
      if (looksLikeFencedApiCall(token) && !FENCED_KEYWORD_DENYLIST.has(token) && !CLAIM_DENYLIST.has(token)) {
        out.add(token);
      }
    }
    for (const match of block.matchAll(SCREAMING_SNAKE_REGEX)) {
      const token = match[1] ?? '';
      if (!FENCED_KEYWORD_DENYLIST.has(token) && !CLAIM_DENYLIST.has(token)) {
        out.add(token);
      }
    }
  }
  return [...out];
}

export function extractFileFingerprint(absPath: string): SkillFileFingerprint {
  const text = readFileSync(absPath, 'utf-8');
  const exports = new Set<string>();
  const patterns = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    /^\s*export\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    /^\s*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    /^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
    /^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) exports.add(match[1]);
    }
  }
  return { exports: [...exports].sort() };
}

function listCodeFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue;
        stack.push(abs);
        continue;
      }
      const ext = extname(abs);
      if (SEARCHABLE_EXTENSIONS.has(ext)) out.push(abs);
    }
  }
  return out;
}

function tokenizeKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(NON_ALNUM_SPACE_REGEX, ' ')
      .split(/\s+/)
      .filter(part => part.length >= 4),
  );
}

function parseProperties(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function loadStoredFingerprint(
  properties: Record<string, unknown>,
  path: string,
): SkillFileFingerprint | null {
  const fingerprints = properties.file_fingerprints;
  if (!fingerprints || typeof fingerprints !== 'object') return null;
  const row = (fingerprints as Record<string, unknown>)[path];
  if (!row || typeof row !== 'object') return null;
  const exports = (row as { exports?: unknown[] }).exports;
  if (!Array.isArray(exports)) return null;
  const asStrings = exports.filter(v => typeof v === 'string') as string[];
  return { exports: asStrings };
}

function buildSymbolPresenceMap(symbols: Set<string>, projectRoot: string): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const symbol of symbols) map.set(symbol, false);
  if (symbols.size === 0) return map;

  // Verify symbols against real SOURCE only. Excluding docs/config — and
  // especially the .agents/skills markdown itself — prevents a skill's own
  // fabricated example from validating its symbol (the symbol appears in the
  // SKILL.md, so an unfiltered content grep would report it "present").
  const files = listCodeFiles(projectRoot).filter(
    (file) => SYMBOL_SEARCH_EXTENSIONS.has(extname(file)) && !SKILL_DOC_PATH_REGEX.test(file),
  );
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const symbol of symbols) {
      if (map.get(symbol)) continue;
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\(\\\)$/, '(?:\\(\\))?');
      const re = new RegExp(`\\b${escaped}\\b`);
      if (re.test(text)) map.set(symbol, true);
    }
  }

  return map;
}

function isTestPath(path: string): boolean {
  return path.includes('__tests__/') || path.endsWith('.test.ts') || path.endsWith('.spec.ts');
}

function shouldFingerprintPath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '.ts' || ext === '.tsx';
}

export function detectDrift(
  skills: SkillDriftInput[],
  projectRoot: string,
  verifiedAt: number,
): SkillDriftResult {
  const skillClaims = new Map<string, ExtractedClaim[]>();
  const skillContents = new Map<string, string>();
  const skillFenced = new Map<string, string[]>();
  const allSymbols = new Set<string>();

  for (const skill of skills) {
    const absPath = resolve(projectRoot, skill.path);
    let content = '';
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      content = '';
    }
    skillContents.set(skill.id, content);
    const claims = extractClaims(content);
    skillClaims.set(skill.id, claims);
    for (const claim of claims) {
      const normalized = claim.token.replace(/\(\)$/, '');
      if (claim.kind === 'symbol' && isDistinctiveSymbol(normalized)) {
        allSymbols.add(normalized);
      }
    }
    // Symbols hiding inside ```code``` examples — the normal claim scan strips
    // fences, so fabricated APIs here would otherwise never be verified.
    const fenced = extractFencedSymbols(content);
    skillFenced.set(skill.id, fenced);
    for (const symbol of fenced) allSymbols.add(symbol);
  }

  const symbolPresence = buildSymbolPresenceMap(allSymbols, projectRoot);

  const reports: SkillDriftReport[] = [];
  let totalMissing = 0;
  let totalInconclusive = 0;
  let totalGrowth = 0;
  let totalFabricationSuspects = 0;

  for (const skill of skills) {
    const props = parseProperties(skill.properties);
    const claims = skillClaims.get(skill.id) ?? [];
    const inlineSymbols = new Set(
      claims.filter(c => c.kind === 'symbol').map(c => c.token.replace(/\(\)$/, '')),
    );
    const fabricationSuspects = (skillFenced.get(skill.id) ?? [])
      .filter(symbol => symbolPresence.get(symbol) === false && !inlineSymbols.has(symbol));
    const loadBearingMisses: string[] = [];
    const inconclusive: string[] = [];
    const growth: string[] = [];
    const currentFingerprints: Record<string, SkillFileFingerprint> = {};
    const headings = (skillContents.get(skill.id) ?? '')
      .split('\n')
      .filter(line => line.startsWith('## '))
      .map(line => line.slice(3));
    const keywords = tokenizeKeywords(`${skill.description} ${headings.join(' ')}`);

    for (const claim of claims) {
      if (claim.kind === 'path') {
        const absPath = resolve(projectRoot, claim.token);
        if (!existsSync(absPath)) {
          loadBearingMisses.push(`Missing path: ${claim.token}`);
          continue;
        }
        if (!isTestPath(claim.token) && shouldFingerprintPath(claim.token)) {
          const fingerprint = extractFileFingerprint(absPath);
          currentFingerprints[claim.token] = fingerprint;
          const stored = loadStoredFingerprint(props, claim.token);
          if (stored) {
            const previous = new Set(stored.exports);
            const added = fingerprint.exports.filter(exp => !previous.has(exp));
            if (added.length > 0) {
              const significant = added.length >= 2 || added.some(exp => keywords.has(exp.toLowerCase()));
              if (significant) growth.push(`${claim.token}: ${added.join(', ')}`);
            }
          }
        }
        continue;
      }

      if (claim.kind === 'symbol') {
        const normalized = claim.token.replace(/\(\)$/, '');
        if (!isDistinctiveSymbol(normalized)) {
          inconclusive.push(`Inconclusive symbol: ${claim.token}`);
          continue;
        }
        if (!symbolPresence.get(normalized)) {
          loadBearingMisses.push(`Missing symbol: ${normalized}`);
        }
      }
    }

    const verifiedCount = claims.length - loadBearingMisses.length - inconclusive.length;
    const confidence = claims.length === 0
      ? 'low'
      : (verifiedCount / claims.length >= 0.8 ? 'high' : verifiedCount / claims.length >= 0.5 ? 'medium' : 'low');

    const severity: SkillDriftReport['severity'] = loadBearingMisses.length >= 3
      ? 'critical'
      : loadBearingMisses.length >= 1
        ? 'major'
        : growth.length > 0
          ? 'minor'
          : inconclusive.length > 0
            ? 'minor'
            : 'none';

    totalMissing += loadBearingMisses.length;
    totalInconclusive += inconclusive.length;
    totalGrowth += growth.length;
    totalFabricationSuspects += fabricationSuspects.length;

    reports.push({
      skillId: skill.id,
      name: skill.name,
      severity,
      confidence,
      notes: loadBearingMisses.length > 0
        ? `Missing load-bearing claims: ${loadBearingMisses.length}`
        : fabricationSuspects.length > 0
          ? `Suspected fabricated example symbols: ${fabricationSuspects.length}`
          : growth.length > 0
            ? `Detected ${growth.length} growth signal(s)`
            : inconclusive.length > 0
              ? `Detected ${inconclusive.length} inconclusive claim(s)`
              : 'No drift detected',
      loadBearingMisses,
      inconclusive,
      growth,
      fabricationSuspects,
      currentFingerprints,
    });
  }

  return {
    verifiedAt,
    reports,
    totalMissing,
    totalInconclusive,
    totalGrowth,
    totalFabricationSuspects,
  };
}

/** Result of verifying a skill's concrete code claims against the codebase. */
export interface SkillClaimVerification {
  /**
   * Inline-backtick path claims that do not exist on disk. The author asserted
   * these as real files — clear fabrication, safe to reject.
   */
  missingPaths: string[];
  /**
   * Inline-backtick distinctive symbol claims absent from the codebase. Also
   * asserted as real — clear fabrication, safe to reject.
   */
  missingInlineSymbols: string[];
  /**
   * Distinctive symbols that appear ONLY inside code fences and are absent.
   * Ambiguous: could be illustrative pseudo-code, so these are surfaced as
   * warnings rather than hard rejections.
   */
  suspectFencedSymbols: string[];
}

/**
 * Deterministically verify the concrete code claims in proposed skill content
 * against the codebase. This is the tool-level fabrication check that does not
 * depend on a model verifying its own work: paths and inline symbols are
 * checked literally, and fenced example code is scanned for invented APIs.
 *
 * When `priorContent` is provided (an evolve write), claims that already
 * existed in the prior version are excluded — the gate only flags fabrication
 * NEWLY introduced by this write, so a pre-existing dead reference does not
 * block an unrelated edit (that is drift's job, not the write gate's).
 *
 * If the codebase cannot be seen (empty/wrong root), returns no findings:
 * never block a write on an unverifiable environment.
 */
export function verifySkillContentClaims(
  content: string,
  projectRoot: string,
  priorContent?: string,
): SkillClaimVerification {
  const empty: SkillClaimVerification = { missingPaths: [], missingInlineSymbols: [], suspectFencedSymbols: [] };
  if (listCodeFiles(projectRoot).length === 0) return empty;

  const inline = extractClaims(content);
  const inlinePaths = [...new Set(inline.filter(c => c.kind === 'path').map(c => c.token))];
  const inlineSymbols = [...new Set(
    inline.filter(c => c.kind === 'symbol')
      .map(c => c.token.replace(/\(\)$/, ''))
      .filter(isDistinctiveSymbol),
  )];
  const fencedSymbols = extractFencedSymbols(content);

  const allSymbols = new Set<string>([...inlineSymbols, ...fencedSymbols]);
  const presence = buildSymbolPresenceMap(allSymbols, projectRoot);

  let missingPaths = inlinePaths.filter(p => !existsSync(resolve(projectRoot, p)));
  let missingInlineSymbols = inlineSymbols.filter(s => presence.get(s) === false);
  const inlineSet = new Set(inlineSymbols);
  let suspectFencedSymbols = fencedSymbols.filter(s => presence.get(s) === false && !inlineSet.has(s));

  if (priorContent !== undefined) {
    const prior = extractClaims(priorContent);
    const priorPaths = new Set(prior.filter(c => c.kind === 'path').map(c => c.token));
    const priorSymbols = new Set(prior.filter(c => c.kind === 'symbol').map(c => c.token.replace(/\(\)$/, '')));
    const priorFenced = new Set(extractFencedSymbols(priorContent));
    missingPaths = missingPaths.filter(p => !priorPaths.has(p));
    missingInlineSymbols = missingInlineSymbols.filter(s => !priorSymbols.has(s));
    suspectFencedSymbols = suspectFencedSymbols.filter(s => !priorFenced.has(s));
  }

  return { missingPaths, missingInlineSymbols, suspectFencedSymbols };
}
