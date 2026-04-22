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
  currentFingerprints: Record<string, SkillFileFingerprint>;
}

export interface SkillDriftResult {
  verifiedAt: number;
  reports: SkillDriftReport[];
  totalMissing: number;
  totalInconclusive: number;
  totalGrowth: number;
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

function stripFrontmatterAndCodeBlocks(content: string): string {
  const body = content.replace(/^---[\s\S]*?---\n/, '');
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '');
}

function isPathToken(token: string): boolean {
  return token.includes('/')
    || token.startsWith('.')
    || /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|sql)$/.test(token);
}

function isDistinctiveSymbol(token: string): boolean {
  if (token.length < 5) return false;
  if (token.endsWith('()')) return true;
  if (token.includes('_')) return true;
  return /[A-Z].*[A-Z]/.test(token);
}

function classifyToken(token: string): ClaimKind {
  if (token.includes(' ') || token.includes('\n')) return 'skip';
  if (isPathToken(token)) return 'path';
  if (!/^[A-Za-z_][A-Za-z0-9_]*\(\)?$/.test(token)) return 'skip';
  if (CLAIM_DENYLIST.has(token.replace(/\(\)$/, ''))) return 'skip';
  return 'symbol';
}

export function extractClaims(content: string): ExtractedClaim[] {
  const body = stripFrontmatterAndCodeBlocks(content);
  const seen = new Set<string>();
  const claims: ExtractedClaim[] = [];
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const token = (match[1] ?? '').trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      claims.push({ token, kind: classifyToken(token) });
    }
  }
  return claims;
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
        stack.push(abs);
        continue;
      }
      const ext = extname(abs);
      if (ext === '.ts' || ext === '.tsx') out.push(abs);
    }
  }
  return out;
}

function tokenizeKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
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

  const codeRoot = join(projectRoot, 'packages');
  const files = listCodeFiles(codeRoot);
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

export function detectDrift(
  skills: SkillDriftInput[],
  projectRoot: string,
  verifiedAt: number,
): SkillDriftResult {
  const skillClaims = new Map<string, ExtractedClaim[]>();
  const skillContents = new Map<string, string>();
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
  }

  const symbolPresence = buildSymbolPresenceMap(allSymbols, projectRoot);

  const reports: SkillDriftReport[] = [];
  let totalMissing = 0;
  let totalInconclusive = 0;
  let totalGrowth = 0;

  for (const skill of skills) {
    const props = parseProperties(skill.properties);
    const claims = skillClaims.get(skill.id) ?? [];
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
        if (!isTestPath(claim.token) && (claim.token.endsWith('.ts') || claim.token.endsWith('.tsx'))) {
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

    reports.push({
      skillId: skill.id,
      name: skill.name,
      severity,
      confidence,
      notes: loadBearingMisses.length > 0
        ? `Missing load-bearing claims: ${loadBearingMisses.length}`
        : growth.length > 0
          ? `Detected ${growth.length} growth signal(s)`
          : inconclusive.length > 0
            ? `Detected ${inconclusive.length} inconclusive claim(s)`
            : 'No drift detected',
      loadBearingMisses,
      inconclusive,
      growth,
      currentFingerprints,
    });
  }

  return {
    verifiedAt,
    reports,
    totalMissing,
    totalInconclusive,
    totalGrowth,
  };
}
