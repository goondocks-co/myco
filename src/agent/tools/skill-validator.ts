/**
 * Skill content validation.
 *
 * Deterministic quality gate -- the agent must fix all issues before
 * a skill is accepted.
 */

/** Maximum lines for a generated skill. */
export const MAX_SKILL_LINES = 800;

/** Required frontmatter fields for Myco-managed skills. */
export const REQUIRED_FRONTMATTER_FIELDS = ['name', 'description', 'managed_by', 'user-invocable', 'allowed-tools'] as const;

/** Frontmatter fields that must not change when updating an existing skill. */
export const PROTECTED_FRONTMATTER_FIELDS = ['user-invocable', 'allowed-tools'] as const;

/**
 * Whitelist of Claude Code tool names that may appear in `allowed-tools`.
 * Myco-managed skills run in developer Claude Code sessions — anything not
 * on this list is almost certainly a model confabulation (e.g. "[None]",
 * "ReadFile", "search", or a vault_* tool copied from the agent's own context).
 *
 * Kept intentionally narrow: add entries when a legitimate tool is rejected.
 */
export const ALLOWED_CLAUDE_CODE_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Edit', 'Write', 'MultiEdit', 'Bash', 'Grep', 'Glob',
  'NotebookRead', 'NotebookEdit', 'WebFetch', 'WebSearch',
  'Task', 'TodoWrite',
]);

/**
 * Extract a frontmatter field value from SKILL.md content.
 * Returns the raw value string, or undefined if not found.
 */
export function extractFrontmatterField(content: string, field: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const match = fmMatch[1].match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1].trim();
}

/**
 * Parse the `allowed-tools` frontmatter value into a list of tool names.
 *
 * Accepts either of these YAML shapes:
 *   allowed-tools: Read, Edit, Write
 *   allowed-tools: [Read, Edit, Write]
 *
 * Returns null if the value is absent, empty, or clearly malformed
 * (e.g. a bare word like `None`, or a list containing `None` / `null`).
 * Caller treats null as a validation failure.
 */
export function parseAllowedTools(rawValue: string | undefined): string[] | null {
  if (!rawValue) return null;
  let stripped = rawValue.trim();
  if (stripped.length === 0) return null;

  // Strip YAML inline-list brackets if present: [Read, Edit] -> Read, Edit
  if (stripped.startsWith('[') && stripped.endsWith(']')) {
    stripped = stripped.slice(1, -1).trim();
  }
  if (stripped.length === 0) return null;

  const parts = stripped
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')) // strip quotes
    .filter((s) => s.length > 0);

  if (parts.length === 0) return null;

  // Reject literal "None" / "null" / "~" — common model confabulations
  // when the model means "no tools needed."
  const sentinels = new Set(['None', 'none', 'null', 'Null', '~']);
  if (parts.some((p) => sentinels.has(p))) return null;

  return parts;
}

/**
 * Light English stemmer applied to every significant token before set
 * comparison. Collapses common suffix variants so that `task`/`tasks`,
 * `gate`/`gates`, `model`/`models`, `configure`/`configuring`, and
 * `implement`/`implemented` all share a stem.
 *
 * The order matters: strip -ing / -ed before trailing -s so "parking"
 * doesn't become "parkin" then "parki"; strip trailing -e last so
 * "validate" and "validating" both land on "validat".
 *
 * Length guards prevent degenerate stems on short words (e.g. "ring"
 * must not become empty, "cod" must not become "c").
 */
function stemToken(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/**
 * Lowercase-word token set from a string, excluding stopwords and
 * short/noise tokens, with light stemming applied. Used for all
 * similarity metrics in this file.
 */
/** Stopwords excluded from token sets — hoisted to module level to avoid
 *  re-allocating on every `tokenSet()` call (matters in O(n²) loops). */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto',
  'for', 'when', 'where', 'which', 'what', 'who', 'how', 'why',
  'use', 'uses', 'used', 'using', 'not', 'also', 'than', 'then',
  'ensure', 'ensures', 'make', 'makes',
]);

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .map(stemToken),
  );
}

/** Internal helper: count shared stems between two token sets. */
function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

/**
 * Jaccard similarity between two text strings on their significant-word
 * token sets. Returns a value in [0, 1].
 *
 * Purpose: detect near-duplicate skill descriptions so `vault_write_skill`
 * can refuse to create sibling skills covering the same topic. This is a
 * deterministic gate — unlike asking the model to self-check for conflicts,
 * which is known to hallucinate "no overlap" on visibly overlapping pairs.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  const intersection = intersectionSize(aTokens, bTokens);
  const union = aTokens.size + bTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Overlap coefficient (Szymkiewicz–Simpson) between two topic strings:
 * `|A ∩ B| / min(|A|, |B|)`. Returns 0 when either side has fewer than
 * `minTokens` significant tokens — 1-2 token topics are dominated by
 * single-token collisions under this metric and must fall back to
 * Jaccard for duplicate detection.
 *
 * Why this exists alongside `descriptionSimilarity`: candidate topics are
 * often short kebab-case labels like `add-idle-skip-watermark-to-agent-task`
 * (5 tokens) paired against longer natural-language topics like
 * `Implementing DB Watermark Prefilters for Incremental Agent Tasks`
 * (6 tokens). The asymmetric token-count inflates Jaccard's union and
 * pushes real duplicates below the 0.4 threshold. Overlap coefficient is
 * robust to that asymmetry because the denominator is the smaller set.
 *
 * The 3-token minimum is calibrated to catch cases like
 * `publish-npm-package-with-oidc-in-ci` (3 significant tokens) against
 * `npm OIDC Trusted Publishing in GitHub Actions` (5 tokens) while
 * leaving 2-token topic pairs to the Jaccard path. Two-token topics
 * with a single shared word would score 0.5 under naive overlap —
 * noisy — so they are deliberately excluded.
 */
export function topicOverlapSimilarity(
  a: string,
  b: string,
  minTokens: number = 3,
): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size < minTokens || bTokens.size < minTokens) return 0;

  const intersection = intersectionSize(aTokens, bTokens);
  const smaller = Math.min(aTokens.size, bTokens.size);
  return smaller === 0 ? 0 : intersection / smaller;
}

/**
 * Similarity threshold above which two descriptions are treated as
 * covering the same topic. Chosen empirically from the unifi-mcp incident
 * that motivated this gate: the real duplicate pair
 * (`unifi-validator-coercion-pattern` vs `unifi-validator-registry-coercion`)
 * scored ~0.42 on this metric — lower than intuition suggests because each
 * description reframes roughly half its content with different wording.
 * Clearly-distinct skill pairs score under 0.2 on the same metric, so 0.4
 * is a comfortable middle that catches real duplicates without flagging
 * incidentally-adjacent topics.
 *
 * Tuning note: the cost of a false positive here is "agent must reframe
 * its description and try again" (low); the cost of a false negative is
 * "sibling skill on disk for the same topic" (high). Lean aggressive.
 */
export const DESCRIPTION_DUPLICATE_THRESHOLD = 0.4;

/**
 * Threshold for the overlap-coefficient topic dedup path. At 0.6 and
 * with a 4-token minimum, this catches recent false negatives where
 * short kebab-case topics were re-identifying dismissed natural-language
 * candidates (watermark/agent/task overlap, structural/enforcement/gate
 * overlap, configure/local/model overlap) while leaving genuinely-new
 * candidates like `implement-spa-sub-navigation-with-browser-history`
 * unaffected.
 */
export const TOPIC_OVERLAP_THRESHOLD = 0.6;

/**
 * Compare protected frontmatter fields between existing and new content.
 * Returns an array of violation descriptions (empty = all preserved).
 *
 * Also guards against description shortening — the description is the
 * primary triggering mechanism for skills, so losing content degrades
 * skill activation quality.
 */
export function checkFrontmatterPreservation(existing: string, incoming: string): string[] {
  const violations: string[] = [];
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    const oldValue = extractFrontmatterField(existing, field);
    const newValue = extractFrontmatterField(incoming, field);
    if (oldValue === undefined || newValue === undefined) continue;

    // For allowed-tools, normalize before comparing — YAML block-list syntax
    // (- Read\n- Edit) and inline syntax (Read, Edit) are semantically identical.
    if (field === 'allowed-tools') {
      const oldParsed = parseAllowedTools(oldValue);
      const newParsed = parseAllowedTools(newValue);
      if (oldParsed && newParsed) {
        const oldSet = new Set(oldParsed);
        const newSet = new Set(newParsed);
        const changed = oldSet.size !== newSet.size || [...oldSet].some(t => !newSet.has(t));
        if (changed) {
          violations.push(`${field}: was [${oldParsed.join(', ')}], changed to [${newParsed.join(', ')}]`);
        }
        continue;
      }
    }

    if (oldValue !== newValue) {
      violations.push(`${field}: was "${oldValue}", changed to "${newValue}"`);
    }
  }

  // Guard against description shortening — descriptions drive skill triggering.
  // Lengthening is allowed (adding context), shortening is not (losing trigger keywords).
  const oldDesc = extractFrontmatterField(existing, 'description');
  const newDesc = extractFrontmatterField(incoming, 'description');
  if (oldDesc && newDesc && newDesc.length < oldDesc.length * 0.9) {
    violations.push(
      `description shortened from ${oldDesc.length} to ${newDesc.length} chars (${Math.round((1 - newDesc.length / oldDesc.length) * 100)}% reduction). ` +
      'Descriptions are the primary triggering mechanism — do not shorten them.',
    );
  }

  return violations;
}

/**
 * Validate skill content before writing. Returns an array of issues
 * (empty = valid). This is a deterministic quality gate -- the agent
 * must fix all issues before the skill is accepted.
 */
export function validateSkillContent(content: string, dirName: string): string[] {
  const issues: string[] = [];

  // Check for frontmatter delimiters
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    issues.push('Missing YAML frontmatter (must start with --- and end with ---)');
    return issues; // Can't check fields without frontmatter
  }

  const frontmatter = fmMatch[1];

  // Check required fields
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!frontmatter.includes(`${field}:`)) {
      issues.push(`Missing required frontmatter field: ${field}`);
    }
  }

  // Check myco: prefix on name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (nameMatch && !nameMatch[1].trim().startsWith('myco:')) {
    issues.push(`Skill name must start with "myco:" prefix. Got: "${nameMatch[1].trim()}"`);
  }

  // Check managed_by: myco
  const managedMatch = frontmatter.match(/^managed_by:\s*(.+)$/m);
  if (managedMatch && managedMatch[1].trim() !== 'myco') {
    issues.push(`managed_by must be "myco". Got: "${managedMatch[1].trim()}"`);
  }

  // Check allowed-tools values -- must be Claude Code tool names, not vault agent tools.
  // These skills run in developer Claude Code sessions, not the agent pipeline.
  const allowedToolsMatch = frontmatter.match(/^allowed-tools:\s*(.+)$/m);
  if (allowedToolsMatch) {
    const rawValue = allowedToolsMatch[1].trim();
    // Reject vault_* tool names first — most informative message for the
    // common LLM mistake of copying its own agent tool context into the skill.
    if (rawValue.includes('vault_')) {
      issues.push(
        'allowed-tools contains vault agent tool names (vault_*). ' +
        'Skills run in Claude Code sessions -- use Claude Code tool names instead: ' +
        'Read, Edit, Write, Bash, Grep, Glob',
      );
    } else {
      // Positive whitelist check — catches "[None]", "None", invented tool
      // names, and other confabulations that the vault_* reject misses.
      const parsed = parseAllowedTools(rawValue);
      if (parsed === null) {
        issues.push(
          `allowed-tools value is malformed or empty: "${rawValue}". ` +
          'Provide a comma-separated list of Claude Code tools, e.g. ' +
          '"Read, Edit, Write, Bash, Grep, Glob". Use the narrowest set ' +
          'the skill actually needs.',
        );
      } else {
        const unknown = parsed.filter((t) => !ALLOWED_CLAUDE_CODE_TOOLS.has(t));
        if (unknown.length > 0) {
          issues.push(
            `allowed-tools contains unknown tool name(s): ${unknown.join(', ')}. ` +
            `Valid Claude Code tools: ${[...ALLOWED_CLAUDE_CODE_TOOLS].join(', ')}.`,
          );
        }
      }
    }
  }
  // Also check YAML list format (- vault_search_fts etc.)
  const listToolLines = frontmatter.match(/^\s+-\s+vault_\w+/gm);
  if (listToolLines) {
    issues.push(
      'allowed-tools contains vault agent tool names (vault_*). ' +
      'Skills run in Claude Code sessions -- use Claude Code tool names instead: ' +
      'Read, Edit, Write, Bash, Grep, Glob',
    );
  }

  // Check line count
  const lineCount = content.split('\n').length;
  if (lineCount > MAX_SKILL_LINES) {
    issues.push(`Skill is ${lineCount} lines (max ${MAX_SKILL_LINES})`);
  }

  return issues;
}
