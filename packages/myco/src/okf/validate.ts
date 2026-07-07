import fs from 'node:fs';
import path from 'node:path';
import { OkfFrontmatterError, parseConceptDoc, REQUIRED_OKF_FRONTMATTER_KEYS } from './frontmatter.js';
import { assertSafeConceptId, detectCollisions, OkfPathError } from './paths.js';
import {
  OKF_MARKER_FILENAME,
  type OkfBundleMode,
  type OkfValidationIssue,
  type OkfValidationLevel,
  type OkfValidationReport,
} from './types.js';

/**
 * Bundle validation, as two entirely separate rule-set families sharing one
 * tree walk.
 *
 * `myco_strict` validates the legacy `OkfConcept` bundle path (still live
 * until Task 1.5 retires it): every non-reserved `.md` has parseable YAML
 * frontmatter and a non-empty `type`, plus Myco's own superset (recommended
 * fields, stable source identity, safe resource URIs, no raw HTML). Content
 * is data, not instructions: prompt-injection text in bodies is NOT a
 * finding. Raw HTML is an error in generated indexes/logs and a warning in
 * concept bodies (a concept's own frontmatter is stored data and never
 * scanned).
 *
 * `conformance`/`strict` validate the OKF v0.1 `OkfDocument` model instead —
 * the format Phase 2 synthesis emits. `conformance` is the reference's real
 * write-time gate (`reference_agent/bundle/document.py`'s `validate()`):
 * parseable frontmatter *mapping* + the four-key floor (`type`, `title`,
 * `description`, `timestamp` all non-empty) on every non-`index.md`/`log.md`
 * `.md`. `strict` is Myco's superset on top of that floor: indexes carry no
 * frontmatter at all, every path segment is `okfSlug`-safe, a relative body
 * link is a *preference* warning (never a hard failure — rejecting either
 * link form would reject a spec-conformant bundle), and a genuinely
 * structure-breaking title/description is flagged as a publish-time backstop
 * against the markdown injection that index generation (`buildIndexBody`)
 * would otherwise emit raw: an embedded newline in either field splices a new
 * line into the generated bullet, and a `]` in `title` specifically closes
 * its `[title](link)` link label early. Parens/`#`/`*` are NOT flagged —
 * they're inert in that template and common in real titles ("Auth (v2)",
 * "Issue #42").
 */

const RECOMMENDED_FIELDS = ['title', 'description', 'timestamp', 'tags'] as const;
const SAFE_RESOURCE_PREFIXES = ['myco://', 'repo://', 'https://'] as const;
/** Findings that downgrade to warnings in local mode (richer local-only provenance is allowed). */
const LOCAL_MODE_DOWNGRADES = new Set(['unsafe_resource_uri']);

// Matches HTML-shaped tags (<b>, </script>, <img src=x>, <br/>) without
// flagging markdown autolinks like <https://example.com> — after the tag name,
// only a space-led attribute block, '/', or an immediate '>' qualifies.
const RAW_HTML_PATTERN = /<\/?[a-zA-Z][-a-zA-Z0-9]*(\s[^>]*)?\/?>/;

// Only these two are genuinely structural in `buildIndexBody`'s
// `* [${title}](${link}) - ${desc}` template — everything else (parens, #,
// *) is inert there and appears in ordinary titles ("Auth (v2)", "Issue
// #42"), so flagging them would be a false-positive publish blocker.
/** Embedded newline/CR — splices a new markdown line into the generated bullet, in either field. */
const UNSAFE_NEWLINE_PATTERN = /[\r\n]/;
/** `]` in a TITLE closes its `[title](link)` link label early; inert in a description (plain trailing text). */
const UNSAFE_TITLE_CLOSE_BRACKET_PATTERN = /\]/;

// Markdown inline links: `[label](target)`. No code-fence exclusion — this
// mirrors RAW_HTML_PATTERN's scope (whole-body scan), and a false positive
// inside a fenced example only ever produces an extra *warning*, never a
// hard failure.
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;
/** Any URL scheme prefix (http:, https:, mailto:, tel:, ...) — never a bundle-relative link. */
const EXTERNAL_LINK_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function containsRawHtml(text: string): boolean {
  return RAW_HTML_PATTERN.test(text);
}

function isSafeResourceUri(uri: string): boolean {
  const lower = uri.trim().toLowerCase();
  return SAFE_RESOURCE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function hasUnsafeFrontmatterText(value: unknown, field: 'title' | 'description'): boolean {
  if (typeof value !== 'string') return false;
  if (UNSAFE_NEWLINE_PATTERN.test(value)) return true;
  return field === 'title' && UNSAFE_TITLE_CLOSE_BRACKET_PATTERN.test(value);
}

/** A same-doc anchor (`#section`) or an absolute (`/`-rooted) or external (`scheme:`) target is not a bundle-relative link. */
function isBundleRelativeLinkTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('/')) return false;
  return !EXTERNAL_LINK_SCHEME_PATTERN.test(trimmed);
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
 *
 * CAVEAT: `level` here keeps its pre-existing, legacy meaning — `'conformance'`
 * is the *old* type-only floor (non-empty `type`, nothing else), NOT the
 * OkfDocument four-key floor `validateBundleTree`'s `'conformance'`/`'strict'`
 * branches enforce below. The same string means two different things
 * depending on entry point; this function is never reached by the
 * document-model walk (see `validateOkfDocumentContent`), so the two never
 * collide in practice, but don't reuse this function for OkfDocument checks.
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
    // Propagate the parser's own code (missing_frontmatter, body_too_large, ...)
    // so consumers get a structured code instead of one blanket label.
    const code = err instanceof OkfFrontmatterError ? err.code : 'unparseable_frontmatter';
    const message = err instanceof OkfFrontmatterError ? err.message : String(err);
    issues.push(issue('error', code, bundleRelPath, message));
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
      const code = err instanceof OkfFrontmatterError ? err.code : 'unparseable_frontmatter';
      const message = err instanceof OkfFrontmatterError ? err.message : String(err);
      issues.push(issue('error', code, relPath, message));
      return;
    }
    if (!isRoot && level === 'myco_strict') {
      issues.push(
        issue('error', 'nonroot_index_frontmatter', relPath, 'non-root index.md files must not carry frontmatter'),
      );
    }
  } else if (isRoot && level === 'myco_strict') {
    // A Myco-generated root index always carries okf_version-led frontmatter;
    // its complete absence must not validate cleaner than a merely incomplete one.
    issues.push(
      issue('error', 'missing_root_frontmatter', relPath, 'bundle-root index.md must carry okf_version frontmatter'),
    );
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

// Defense-in-depth: readdir-walked paths can never contain '.', '..', or NUL,
// but this rule set is the contract for "no unsafe paths" at myco_strict and
// must hold if the tree listing ever comes from a non-filesystem provider
// (archive import, remote manifest).
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
 * `strict`-only: every path segment (directories and filename alike) must be
 * `okfSlug`-safe — the same choke point `renderOkfDocument` runs a document's
 * `path` through before it is ever written. Reuses `assertSafeConceptId`
 * rather than duplicating its charset, so the write-time and validate-time
 * rules can never drift apart.
 */
function checkOkfSlugSafety(relPath: string, issues: OkfValidationIssue[]): void {
  try {
    assertSafeConceptId(relPath);
  } catch (err) {
    const code = err instanceof OkfPathError ? err.code : 'invalid_segment';
    const message = err instanceof Error ? err.message : String(err);
    issues.push(issue('error', code, relPath, message));
  }
}

/** `strict`-only: an OKF index.md — root or nested — must carry no frontmatter block at all. */
function checkOkfIndexHasNoFrontmatter(content: string, relPath: string, issues: OkfValidationIssue[]): void {
  if (content.replace(/\r\n/g, '\n').startsWith('---\n')) {
    issues.push(issue('error', 'index_has_frontmatter', relPath, 'OKF index.md files must carry no frontmatter block'));
  }
}

/** `strict`-only: warn on every markdown link in `body` whose target is bundle-relative rather than absolute. */
function checkLinkPreference(body: string, relPath: string, issues: OkfValidationIssue[]): void {
  for (const match of body.matchAll(MARKDOWN_LINK_PATTERN)) {
    const target = match[1];
    if (isBundleRelativeLinkTarget(target)) {
      issues.push(
        issue(
          'warning',
          'prefer_absolute_link',
          relPath,
          `link target ${JSON.stringify(target)} is bundle-relative; an absolute ("/"-rooted) link is preferred and move-stable`,
        ),
      );
    }
  }
}

/**
 * Single-document rule set for an OKF v0.1 content document (non-reserved,
 * i.e. not `index.md`/`log.md`). `conformance` is the reference's real
 * write-time floor; `strict` adds the hostile-frontmatter-text backstop and
 * the link-preference scan.
 */
function validateOkfDocumentContent(
  content: string,
  relPath: string,
  level: 'conformance' | 'strict',
  issues: OkfValidationIssue[],
): void {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseConceptDoc(content));
  } catch (err) {
    const code = err instanceof OkfFrontmatterError ? err.code : 'unparseable_frontmatter';
    const message = err instanceof OkfFrontmatterError ? err.message : String(err);
    issues.push(issue('error', code, relPath, message));
    return;
  }

  for (const key of REQUIRED_OKF_FRONTMATTER_KEYS) {
    if (!frontmatter[key]) {
      issues.push(
        issue('error', 'missing_required_frontmatter_key', relPath, `OKF frontmatter floor requires a non-empty "${key}"`),
      );
    }
  }

  if (level === 'strict') {
    for (const key of ['title', 'description'] as const) {
      if (hasUnsafeFrontmatterText(frontmatter[key], key)) {
        const reason = key === 'title' ? 'a newline or a "]"' : 'a newline';
        issues.push(
          issue(
            'error',
            'unsafe_frontmatter_text',
            relPath,
            `frontmatter "${key}" contains ${reason} — unsafe once rendered into a generated index bullet's "[title](link) - desc" markdown`,
          ),
        );
      }
    }
    checkLinkPreference(body, relPath, issues);
  }
}

/**
 * Walk a bundle tree on disk and validate it. Only `.md` files are validated;
 * the marker (`.myco-okf-maintain.json`) and any other non-markdown files are
 * non-concept files and are skipped. Symlinks — directories AND files — are
 * not followed: a symlinked `.md` is not a regular file and is excluded from
 * `filesChecked`.
 *
 * `mode` defaults to `'published'`. In `'local'` mode, unsafe-resource findings
 * downgrade to warnings (local bundles may carry richer local-only provenance).
 * `mode` only affects `myco_strict` findings; the OKF document-model levels
 * never emit a downgradable code.
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
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
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

      if (level !== 'myco_strict') {
        // OKF document-model levels: an entirely separate rule set from the
        // legacy OkfConcept walk below — see the module-level doc comment.
        if (level === 'strict') checkOkfSlugSafety(relPath, issues);
        if (entry.name === 'index.md') {
          if (level === 'strict') checkOkfIndexHasNoFrontmatter(content, relPath, issues);
        } else if (entry.name !== 'log.md') {
          conceptsChecked += 1;
          validateOkfDocumentContent(content, relPath, level, issues);
        }
        continue;
      }

      if (entry.name === 'index.md') {
        validateIndexFile(content, relPath, relDir === '', level, issues);
      } else if (entry.name === 'log.md') {
        validateLogFile(content, relPath, level, issues);
      } else {
        conceptsChecked += 1;
        issues.push(...validateConceptSource(content, relPath, level));
        checkPathSafety(relPath, issues);
        conceptIds.push(relPath.slice(0, -'.md'.length));
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
