import fs from 'node:fs';
import path from 'node:path';
import { isCanopySensitivePath } from '@myco/canopy/sensitive-paths.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import { parseConceptDoc } from './frontmatter.js';
import { OKF_MARKER_FILENAME } from './types.js';

/**
 * Publish-eligibility scanner. A repo-visible ("published") bundle must not
 * leak secrets, local paths, or raw per-machine identifiers. This is
 * defense-in-depth on top of the projectors' published-mode omission: it
 * catches agent-authored concepts and any projector regression.
 *
 * Findings are advisory — the caller (OkfBundle) blocks a first publish until
 * the finding set is acknowledged, and a NEW distinct finding re-blocks. So a
 * rare false positive costs one acknowledgement, never data loss.
 */

export type PublishFindingCode =
  | 'likely_secret'
  | 'absolute_local_path'
  | 'raw_session_identifier'
  | 'sensitive_filename';

export interface PublishFinding {
  code: PublishFindingCode;
  /** Bundle-relative path of the offending file. */
  path: string;
  /** Short, secret-masked snippet for display (never the full secret). */
  excerpt: string;
  /**
   * Non-reversible hash of the raw offending content. Binds an acknowledgement
   * to THIS finding: a different secret at the same (code, path) yields a new
   * hash and re-blocks publish rather than riding a prior acknowledgement.
   */
  hash: string;
}

/** 16 hex chars of SHA-256 — enough to distinguish findings, never the secret. */
function findingHash(raw: string): string {
  return sha256Hex(raw).slice(0, 16);
}

/** Secret-shaped token detectors. One exported constant so the set is auditable. */
export const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws_secret_key', re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}\b/i },
  { label: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'private_key_header', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { label: 'generic_bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

/** Absolute local filesystem paths that must never appear in a published bundle. */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /\/Users\/[^/\s"']+/,
  /\/home\/[^/\s"']+/,
  /\/root\//,
  /[A-Za-z]:\\Users\\[^\\\s"']+/,
];

/** UUID-shaped session identifiers (v1–v8), and the raw identifier key names. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RAW_ID_KEY_RE = /(^|[^a-z])(session_id|prompt_batch_id|machine_id)\s*[:=]/im;

function maskExcerpt(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - 12);
  const raw = text.slice(start, index + matchLength + 12).replace(/\s+/g, ' ').trim();
  // Mask the middle of long matched runs so the finding never re-leaks the secret.
  if (matchLength > 12) {
    const head = text.slice(index, index + 4);
    const tail = text.slice(index + matchLength - 4, index + matchLength);
    return `${text.slice(start, index).replace(/\s+/g, ' ').trim()} ${head}…${tail}`.trim();
  }
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

function scanText(text: string, relPath: string, findings: PublishFinding[]): void {
  for (const { re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({ code: 'likely_secret', path: relPath, excerpt: maskExcerpt(text, m.index, m[0].length), hash: findingHash(m[0]) });
      break; // one secret finding per file is enough to block
    }
  }
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({ code: 'absolute_local_path', path: relPath, excerpt: maskExcerpt(text, m.index, m[0].length), hash: findingHash(m[0]) });
      break;
    }
  }
  const keyMatch = RAW_ID_KEY_RE.exec(text);
  const uuidMatch = UUID_RE.exec(text);
  if (keyMatch) {
    findings.push({ code: 'raw_session_identifier', path: relPath, excerpt: maskExcerpt(text, keyMatch.index, keyMatch[0].length), hash: findingHash(keyMatch[0]) });
  } else if (uuidMatch) {
    findings.push({ code: 'raw_session_identifier', path: relPath, excerpt: maskExcerpt(text, uuidMatch.index, uuidMatch[0].length), hash: findingHash(uuidMatch[0]) });
  }
}

function representedRepoPath(rawContent: string, relPath: string): string | null {
  try {
    const { frontmatter } = parseConceptDoc(rawContent);
    if (typeof frontmatter.myco_path === 'string') return frontmatter.myco_path;
    if (typeof frontmatter.resource === 'string' && frontmatter.resource.startsWith('repo://')) {
      return frontmatter.resource.slice('repo://'.length);
    }
  } catch {
    /* fall through to path-derived */
  }
  const canopyPrefix = 'canopy/files/';
  if (relPath.startsWith(canopyPrefix) && relPath.endsWith('.md')) {
    return relPath.slice(canopyPrefix.length, -'.md'.length);
  }
  return null;
}

/** Recursively scan a staged bundle tree; returns findings in deterministic path order. */
export function scanStagedBundle(stagingRoot: string): PublishFinding[] {
  const findings: PublishFinding[] = [];

  const walk = (relDir: string): void => {
    const absDir = relDir === '' ? stagingRoot : path.join(stagingRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile() || entry.name === OKF_MARKER_FILENAME || !entry.name.endsWith('.md')) continue;

      let content: string;
      try {
        content = fs.readFileSync(path.join(stagingRoot, relPath), 'utf8');
      } catch {
        continue;
      }
      scanText(content, relPath, findings);
      const repoPath = representedRepoPath(content, relPath);
      if (repoPath && isCanopySensitivePath(repoPath)) {
        findings.push({ code: 'sensitive_filename', path: relPath, excerpt: repoPath, hash: findingHash(repoPath) });
      }
    }
  };

  walk('');
  return findings;
}
