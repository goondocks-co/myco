#!/usr/bin/env node
// scan-content.mjs — pre-commit content scanner for an OKF wiki tree.
//
// Distilled from packages/myco/src/okf/publish-eligibility.ts's finding
// patterns (secrets, absolute local paths, raw session identifiers) before
// that module was deleted alongside the rest of the built OKF feature.
// Zero-dependency: only Node.js core modules, so it runs standalone from any
// wiki root with no `npm install` step and no repo-specific import paths.
//
// Usage:
//   node scan-content.mjs <directory>
//
// Exit codes:
//   0 — no findings.
//   1 — one or more findings; do not commit until each is resolved (redact
//       the content) or you've confirmed it's a false positive.
//   2 — usage error (missing or non-directory argument).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Directories never worth descending into for wiki content. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Secret-shaped token detectors. One array so the set is auditable in one place. */
const SECRET_PATTERNS = [
  { label: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'aws_secret_key', re: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}\b/i },
  { label: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'private_key_header', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { label: 'generic_bearer', re: /\bbearer\s+[A-Za-z0-9._-]{20,}\b/i },
];

/** Absolute local filesystem paths that must never appear in a published wiki page. */
const ABSOLUTE_PATH_PATTERNS = [
  /\/Users\/[^/\s"']+/,
  /\/home\/[^/\s"']+/,
  /\/root\//,
  /[A-Za-z]:\\Users\\[^\\\s"']+/,
];

/** UUID-shaped session identifiers (v1-v8), and the raw identifier key names. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RAW_ID_KEY_RE = /(^|[^a-z])(session_id|prompt_batch_id|machine_id)\s*[:=]/im;

/** 16 hex chars of SHA-256 — enough to distinguish findings, never the secret itself. */
function findingHash(raw) {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

/** Short, secret-masked snippet for display (never the full matched text). */
function maskExcerpt(text, index, matchLength) {
  const start = Math.max(0, index - 12);
  if (matchLength > 12) {
    const head = text.slice(index, index + 4);
    const tail = text.slice(index + matchLength - 4, index + matchLength);
    return `${text.slice(start, index).replace(/\s+/g, ' ').trim()} ${head}…${tail}`.trim();
  }
  const raw = text.slice(start, index + matchLength + 12).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

function scanText(text, relPath, findings) {
  for (const { re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        code: 'likely_secret',
        path: relPath,
        excerpt: maskExcerpt(text, m.index, m[0].length),
        hash: findingHash(m[0]),
      });
      break; // one secret finding per file is enough to block
    }
  }
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      findings.push({
        code: 'absolute_local_path',
        path: relPath,
        excerpt: maskExcerpt(text, m.index, m[0].length),
        hash: findingHash(m[0]),
      });
      break;
    }
  }
  const keyMatch = RAW_ID_KEY_RE.exec(text);
  const uuidMatch = UUID_RE.exec(text);
  if (keyMatch) {
    findings.push({
      code: 'raw_session_identifier',
      path: relPath,
      excerpt: maskExcerpt(text, keyMatch.index, keyMatch[0].length),
      hash: findingHash(keyMatch[0]),
    });
  } else if (uuidMatch) {
    findings.push({
      code: 'raw_session_identifier',
      path: relPath,
      excerpt: maskExcerpt(text, uuidMatch.index, uuidMatch[0].length),
      hash: findingHash(uuidMatch[0]),
    });
  }
}

/** Recursively scan a directory tree for `.md` files; returns findings in deterministic path order. */
function scanDirectory(root) {
  const findings = [];

  const walk = (relDir) => {
    const absDir = relDir === '' ? root : path.join(root, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      let content;
      try {
        content = fs.readFileSync(path.join(root, relPath), 'utf8');
      } catch {
        continue;
      }
      scanText(content, relPath, findings);
    }
  };

  walk('');
  return findings;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scan-content.mjs <directory>');
    process.exit(2);
  }
  const root = path.resolve(target);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    console.error(`scan-content: ${root} does not exist`);
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    console.error(`scan-content: ${root} is not a directory`);
    process.exit(2);
  }

  const findings = scanDirectory(root);
  if (findings.length === 0) {
    console.log(`scan-content: clean — 0 findings in ${root}`);
    process.exit(0);
  }

  console.error(`scan-content: ${findings.length} finding(s) in ${root}\n`);
  for (const f of findings) {
    console.error(`  [${f.code}] ${f.path}`);
    console.error(`    ${f.excerpt}`);
    console.error(`    hash: ${f.hash}\n`);
  }
  console.error('Resolve each finding (redact the content, or confirm it is a false positive) before advising the user to commit.');
  process.exit(1);
}

main();
