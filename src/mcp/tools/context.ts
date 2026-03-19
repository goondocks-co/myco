import fs from 'node:fs';
import path from 'node:path';
import { stripFrontmatter } from '../../vault/frontmatter.js';
import { DIGEST_TIERS } from '../../constants.js';

/** Default tier when none is requested. */
const DEFAULT_CONTEXT_TIER = 3000;

interface ContextInput {
  tier?: number;
}

export interface ContextResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated?: string;
}

/**
 * Try to read a digest extract file. Returns null if the file doesn't exist.
 * Strips YAML frontmatter and extracts the generated timestamp.
 */
function tryReadExtract(filePath: string, tier: number, fallback: boolean): ContextResult | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { body, frontmatter } = stripFrontmatter(raw);
  const generated = frontmatter.generated as string | undefined;

  return {
    content: body,
    tier,
    fallback,
    generated,
  };
}

export function handleMycoContext(vaultDir: string, input: ContextInput): ContextResult {
  const requestedTier = input.tier ?? DEFAULT_CONTEXT_TIER;
  const digestDir = path.join(vaultDir, 'digest');

  // Try exact tier first
  const exact = tryReadExtract(path.join(digestDir, `extract-${requestedTier}.md`), requestedTier, false);
  if (exact) return exact;

  // Fall back to nearest available tier
  const candidates = [...DIGEST_TIERS]
    .sort((a, b) => Math.abs(a - requestedTier) - Math.abs(b - requestedTier));

  for (const tier of candidates) {
    const result = tryReadExtract(path.join(digestDir, `extract-${tier}.md`), tier, true);
    if (result) return result;
  }

  return {
    content: 'Digest context is not yet available. The first digest cycle has not completed.',
    tier: requestedTier,
    fallback: false,
  };
}
