/**
 * Skill content validation.
 *
 * Deterministic quality gate -- the agent must fix all issues before
 * a skill is accepted.
 */

/** Maximum lines for a generated skill. */
export const MAX_SKILL_LINES = 500;

/** Required frontmatter fields for Myco-managed skills. */
export const REQUIRED_FRONTMATTER_FIELDS = ['name', 'description', 'managed_by', 'user-invocable', 'allowed-tools'] as const;

/** Frontmatter fields that must not change when updating an existing skill. */
export const PROTECTED_FRONTMATTER_FIELDS = ['user-invocable', 'allowed-tools'] as const;

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
 * Compare protected frontmatter fields between existing and new content.
 * Returns an array of violation descriptions (empty = all preserved).
 */
export function checkFrontmatterPreservation(existing: string, incoming: string): string[] {
  const violations: string[] = [];
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    const oldValue = extractFrontmatterField(existing, field);
    const newValue = extractFrontmatterField(incoming, field);
    if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
      violations.push(`${field}: was "${oldValue}", changed to "${newValue}"`);
    }
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
    const toolsValue = allowedToolsMatch[1].trim();
    // Reject vault_* tool names -- common LLM mistake of copying its own tool context
    if (toolsValue.includes('vault_')) {
      issues.push(
        'allowed-tools contains vault agent tool names (vault_*). ' +
        'Skills run in Claude Code sessions -- use Claude Code tool names instead: ' +
        'Read, Edit, Write, Bash, Grep, Glob'
      );
    }
  }
  // Also check YAML list format (- vault_search_fts etc.)
  const listToolLines = frontmatter.match(/^\s+-\s+vault_\w+/gm);
  if (listToolLines) {
    issues.push(
      'allowed-tools contains vault agent tool names (vault_*). ' +
      'Skills run in Claude Code sessions -- use Claude Code tool names instead: ' +
      'Read, Edit, Write, Bash, Grep, Glob'
    );
  }

  // Check line count
  const lineCount = content.split('\n').length;
  if (lineCount > MAX_SKILL_LINES) {
    issues.push(`Skill is ${lineCount} lines (max ${MAX_SKILL_LINES})`);
  }

  return issues;
}
