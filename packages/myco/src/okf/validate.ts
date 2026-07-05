import fs from 'node:fs';
import path from 'node:path';
import { OkfFrontmatterError, parseConceptDoc } from './frontmatter.js';
import { detectCollisions } from './paths.js';
import {
  OKF_MARKER_FILENAME,
  type OkfBundleMode,
  type OkfValidationIssue,
  type OkfValidationLevel,
  type OkfValidationReport,
} from './types.js';

/**
 * Bundle validation at two composed levels.
 *
 * `conformance` is the OKF v0.1 floor: every non-reserved `.md` has parseable
 * YAML frontmatter and a non-empty `type`; unknown types/keys, missing optional
 * fields, and broken links are all acceptable. `myco_strict` is the superset
 * Myco-generated output must satisfy. The two rule sets stay separately composed
 * (strict runs on top of conformance) because the future import path will run
 * `conformance` only.
 *
 * Content is data, not instructions: prompt-injection text in bodies is NOT a
 * finding. Raw HTML is an error in generated indexes/logs and a warning in
 * concept bodies (a concept's own frontmatter is stored data and never scanned).
 */

const RECOMMENDED_FIELDS = ['title', 'description', 'timestamp', 'tags'] as const;
const SAFE_RESOURCE_PREFIXES = ['myco://', 'repo://', 'https://'] as const;
/** Findings that downgrade to warnings in local mode (richer local-only provenance is allowed). */
const LOCAL_MODE_DOWNGRADES = new Set(['unsafe_resource_uri']);

const RAW_HTML_PATTERN = /<\/?[a-zA-Z][^>]*>/;

function containsRawHtml(text: string): boolean {
  return RAW_HTML_PATTERN.test(text);
}

function isSafeResourceUri(uri: string): boolean {
  const lower = uri.trim().toLowerCase();
  return SAFE_RESOURCE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function issue(
  level: 'error' | 'warning',
  code: string,
  relPath: string,
  message: string,
): OkfValidationIssue {
  return { level, code, path: relPath, message };
}

/**
 * Single-document rule set for a non-reserved concept file. Shared with the
 * OkfBundle/MCP concept-write paths (Plans 4–5), which validate agent-authored
 * source before it ever reaches a bundle tree.
 */
export function validateConceptSource(
  raw: string,
  bundleRelPath: string,
  level: OkfValidationLevel,
): OkfValidationIssue[] {
  const issues: OkfValidationIssue[] = [];
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseConceptDoc(raw));
  } catch (err) {
    const message = err instanceof OkfFrontmatterError ? err.message : String(err);
    issues.push(issue('error', 'unparseable_frontmatter', bundleRelPath, message));
    return issues;
  }

  const type = frontmatter.type;
  if (typeof type !== 'string' || type.trim() === '') {
    issues.push(issue('error', 'missing_type', bundleRelPath, 'frontmatter must declare a non-empty "type"'));
  }

  if (level === 'myco_strict') {
    for (const field of RECOMMENDED_FIELDS) {
      const value = frontmatter[field];
      const missing =
        value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
      if (missing) {
        issues.push(
          issue('error', 'missing_recommended_field', bundleRelPath, `recommended field "${field}" is missing`),
        );
      }
    }

    const hasIdentity = [frontmatter.myco_id, frontmatter.myco_path, frontmatter.resource].some(
      (value) => typeof value === 'string' && value.trim() !== '',
    );
    if (!hasIdentity) {
      issues.push(
        issue(
          'error',
          'missing_source_identity',
          bundleRelPath,
          'stable source identity required: one of "myco_id", "myco_path", or "resource"',
        ),
      );
    }

    if (typeof frontmatter.resource === 'string' && !isSafeResourceUri(frontmatter.resource)) {
      issues.push(
        issue(
          'error',
          'unsafe_resource_uri',
          bundleRelPath,
          `"resource" must use one of ${SAFE_RESOURCE_PREFIXES.join(', ')} — got ${JSON.stringify(frontmatter.resource)}`,
        ),
      );
    }

    if (containsRawHtml(body)) {
      issues.push(issue('warning', 'raw_html', bundleRelPath, 'raw HTML in concept body'));
    }
  }

  return issues;
}

function validateIndexFile(
  content: string,
  relPath: string,
  isRoot: boolean,
  level: OkfValidationLevel,
  issues: OkfValidationIssue[],
): void {
  const hasFrontmatter = content.replace(/\r\n/g, '\n').startsWith('---\n');
  let scanBody = content;
  if (hasFrontmatter) {
    try {
      const parsed = parseConceptDoc(content);
      scanBody = parsed.body;
      if (isRoot && parsed.frontmatter.okf_version === undefined) {
        issues.push(
          issue('warning', 'missing_okf_version', relPath, 'bundle-root index.md frontmatter should declare "okf_version"'),
        );
      }
    } catch (err) {
      const message = err instanceof OkfFrontmatterError ? err.message : String(err);
      issues.push(issue('error', 'unparseable_frontmatter', relPath, message));
      return;
    }
    if (!isRoot && level === 'myco_strict') {
      issues.push(
        issue('error', 'nonroot_index_frontmatter', relPath, 'non-root index.md files must not carry frontmatter'),
      );
    }
  }
  if (level === 'myco_strict' && containsRawHtml(scanBody)) {
    issues.push(issue('error', 'raw_html', relPath, 'raw HTML in generated index'));
  }
}

function validateLogFile(
  content: string,
  relPath: string,
  level: OkfValidationLevel,
  issues: OkfValidationIssue[],
): void {
  if (!content.startsWith('# ')) {
    issues.push(issue('warning', 'malformed_log', relPath, 'log.md should begin with a "# " heading'));
  }
  if (level === 'myco_strict' && containsRawHtml(content)) {
    issues.push(issue('error', 'raw_html', relPath, 'raw HTML in generated log'));
  }
}

function checkPathSafety(relPath: string, issues: OkfValidationIssue[]): void {
  for (const segment of relPath.split('/')) {
    if (segment === '.' || segment === '..') {
      issues.push(issue('error', 'path_traversal', relPath, `path contains traversal segment ${JSON.stringify(segment)}`));
      return;
    }
    if (segment.includes('\0')) {
      issues.push(issue('error', 'path_traversal', relPath, 'path contains a NUL byte'));
      return;
    }
  }
}

/**
 * Walk a bundle tree on disk and validate it. Only `.md` files are validated;
 * the marker (`.myco-okf-maintain.json`) and any other non-markdown files are
 * non-concept files and are skipped. Symlinked directories are not followed.
 *
 * `mode` defaults to `'published'`. In `'local'` mode, unsafe-resource findings
 * downgrade to warnings (local bundles may carry richer local-only provenance).
 */
export function validateBundleTree(
  root: string,
  level: OkfValidationLevel,
  opts?: { mode?: OkfBundleMode },
): OkfValidationReport {
  const mode = opts?.mode ?? 'published';
  const issues: OkfValidationIssue[] = [];
  let filesChecked = 0;
  let conceptsChecked = 0;
  const conceptIds: string[] = [];

  const walk = (relDir: string): void => {
    const absDir = relDir === '' ? root : path.join(root, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      issues.push(
        issue('error', 'unreadable_directory', relDir === '' ? '.' : relDir, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === OKF_MARKER_FILENAME || !entry.name.endsWith('.md')) continue;

      filesChecked += 1;
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, relPath), 'utf8');
      } catch (err) {
        issues.push(issue('error', 'unreadable_file', relPath, err instanceof Error ? err.message : String(err)));
        continue;
      }

      if (entry.name === 'index.md') {
        validateIndexFile(content, relPath, relDir === '', level, issues);
      } else if (entry.name === 'log.md') {
        validateLogFile(content, relPath, level, issues);
      } else {
        conceptsChecked += 1;
        issues.push(...validateConceptSource(content, relPath, level));
        if (level === 'myco_strict') {
          checkPathSafety(relPath, issues);
          conceptIds.push(relPath.slice(0, -'.md'.length));
        }
      }
    }
  };

  walk('');

  if (level === 'myco_strict') {
    for (const id of new Set(detectCollisions(conceptIds))) {
      issues.push(
        issue('error', 'duplicate_concept_id', `${id}.md`, 'concept id collides with another id after case-fold normalization'),
      );
    }
  }

  const effective =
    mode === 'local'
      ? issues.map((entry) =>
          entry.level === 'error' && LOCAL_MODE_DOWNGRADES.has(entry.code) ? { ...entry, level: 'warning' as const } : entry,
        )
      : issues;

  return {
    ok: !effective.some((entry) => entry.level === 'error'),
    level,
    filesChecked,
    conceptsChecked,
    issues: effective,
  };
}
