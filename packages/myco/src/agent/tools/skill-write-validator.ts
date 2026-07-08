/**
 * Pure skill-write validation helper — composes all write gates into a single
 * pass that returns every problem at once.
 *
 * `vault_write_skill` previously ran gates sequentially with early returns, so
 * the agent only ever saw one class of error per attempt and had to iterate
 * (fix length → trip floor → fix floor → trip fabrication …). This helper
 * surfaces ALL fixable problems in one response together with the satisfiable
 * description window, eliminating the oscillation.
 *
 * No disk writes, no DB access. `priorContent` and `root` are passed in by
 * the caller. Designed to also serve `vault_stage_skill`/`vault_finalize_skill`
 * (Task 3) — the `{ content, name, priorContent, root }` signature is stable.
 */

import {
  validateSkillContent,
  checkFrontmatterPreservation,
  computeDescriptionFloor,
  extractFrontmatterField,
  MAX_SKILL_DESCRIPTION_CHARS,
} from './skill-validator.js';
import { verifySkillContentClaims } from '@myco/agent/skill-drift.js';

/** Fabrication findings for a write rejected by the claim gate. */
export interface SkillFabricationClaim {
  /** Inline-backtick path claims absent from the repository. */
  missing_paths: string[];
  /** Inline-backtick symbol claims absent from the codebase. */
  missing_symbols: string[];
  /** Symbols inside code fences that are absent — ambiguous, surfaced for review. */
  unverified_example_symbols?: string[];
}

/** Satisfiable range for the skill description on an update write. */
export interface SkillDescriptionWindow {
  /** Minimum allowed length (floor from the clamped+decontaminated old length × 0.9). */
  min: number;
  /** Maximum allowed length (the ceiling enforced by all symbiont frontmatter readers). */
  max: number;
  /** Length of the description in the proposed content. */
  current: number;
}

/** Collected results from all write-time validation gates. */
export interface SkillWriteValidation {
  /** Issues from `validateSkillContent` (ceiling, structure, contamination, allowed-tools). */
  issues: string[];
  /** Frontmatter-preservation violations (protected fields, description floor). */
  violations: string[];
  /** Fabrication findings, or null when the claim gate passes. */
  claim: SkillFabricationClaim | null;
  /**
   * Satisfiable description range. Defined only when `priorContent` is supplied
   * (i.e. an update write); lets callers tell the agent what window it must target.
   */
  descWindow?: SkillDescriptionWindow;
}

/**
 * Run every write-time content gate in one pass and return all findings.
 *
 *   - `content`      — proposed SKILL.md text (with frontmatter).
 *   - `name`         — skill directory name (validates the `name:` frontmatter field).
 *   - `priorContent` — existing on-disk SKILL.md text, if any (undefined for creates).
 *   - `root`         — project root for the fabrication/claim gate filesystem scan.
 *   - `hostServed`   — true on a Team Host run served for a remote member: the
 *                      host lacks the member's working tree, so the fabrication
 *                      gate (which scans `root`) would see every path/symbol as
 *                      missing and falsely reject. Skip it — the member's tree is
 *                      re-scanned when the skill is published there on accept.
 *
 * Returns a `SkillWriteValidation` whose fields are all non-blocking when empty/null.
 * The caller decides whether to reject and composes the error response.
 */
export function collectSkillWriteIssues(args: {
  content: string;
  name: string;
  priorContent?: string;
  root: string;
  hostServed?: boolean;
}): SkillWriteValidation {
  const { content, name, priorContent, root, hostServed } = args;

  // Gate 1: structural/ceiling/contamination/allowed-tools
  const issues = validateSkillContent(content, name);

  // Gate 2: frontmatter field preservation (updates only)
  const violations = priorContent !== undefined
    ? checkFrontmatterPreservation(priorContent, content)
    : [];

  // Gate 3: fabrication — verify inline path/symbol claims against the codebase.
  // Skipped on a host-served run: the host has no member working tree to scan, so
  // the scan would flag every real claim as fabricated (a false rejection).
  const claimCheck = hostServed
    ? { missingPaths: [], missingInlineSymbols: [], suspectFencedSymbols: [] }
    : verifySkillContentClaims(content, root, priorContent);
  let claim: SkillFabricationClaim | null = null;
  if (claimCheck.missingPaths.length > 0 || claimCheck.missingInlineSymbols.length > 0) {
    claim = {
      missing_paths: claimCheck.missingPaths,
      missing_symbols: claimCheck.missingInlineSymbols,
      ...(claimCheck.suspectFencedSymbols.length > 0
        ? { unverified_example_symbols: claimCheck.suspectFencedSymbols }
        : {}),
    };
  } else if (claimCheck.suspectFencedSymbols.length > 0) {
    // Fenced-only suspects — not a hard rejection, warn for author visibility
    console.warn(
      `[collectSkillWriteIssues] '${name}': code-fence examples reference symbols not found in the codebase: `
      + `${claimCheck.suspectFencedSymbols.join(', ')}. If these are real APIs, confirm they exist; `
      + 'if illustrative, prefer names that cannot be mistaken for real references.',
    );
  }

  // Description window — only meaningful on updates
  let descWindow: SkillDescriptionWindow | undefined;
  if (priorContent !== undefined) {
    const newDesc = extractFrontmatterField(content, 'description');
    if (newDesc !== undefined) {
      descWindow = {
        min: Math.ceil(computeDescriptionFloor(priorContent)),
        max: MAX_SKILL_DESCRIPTION_CHARS,
        current: newDesc.length,
      };
    }
  }

  return { issues, violations, claim, descWindow };
}
