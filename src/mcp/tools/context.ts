import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DIGEST_TIERS } from '../../constants.js';

interface ContextInput {
  tier?: number;
}

interface ContextResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated?: string;
}

/**
 * Read a digest extract file, strip YAML frontmatter, and extract metadata.
 */
function readExtract(filePath: string, tier: number, fallback: boolean): ContextResult {
  const raw = fs.readFileSync(filePath, 'utf-8');

  let generated: string | undefined;
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n*/);
  if (fmMatch) {
    try {
      const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
      generated = parsed.generated as string | undefined;
    } catch { /* ignore malformed frontmatter */ }
    body = raw.slice(fmMatch[0].length).trim();
  }

  return {
    content: body,
    tier,
    fallback,
    generated,
  };
}

export function handleMycoContext(vaultDir: string, input: ContextInput): ContextResult {
  const requestedTier = input.tier ?? 3000;
  const digestDir = path.join(vaultDir, 'digest');

  // Try exact tier first
  const exactPath = path.join(digestDir, `extract-${requestedTier}.md`);
  if (fs.existsSync(exactPath)) {
    return readExtract(exactPath, requestedTier, false);
  }

  // Fall back to nearest available tier
  const available = DIGEST_TIERS
    .filter((t) => fs.existsSync(path.join(digestDir, `extract-${t}.md`)))
    .sort((a, b) => Math.abs(a - requestedTier) - Math.abs(b - requestedTier));

  if (available.length > 0) {
    const fallbackTier = available[0];
    return readExtract(path.join(digestDir, `extract-${fallbackTier}.md`), fallbackTier, true);
  }

  return {
    content: 'Digest context is not yet available. The first digest cycle has not completed.',
    tier: requestedTier,
    fallback: false,
  };
}
