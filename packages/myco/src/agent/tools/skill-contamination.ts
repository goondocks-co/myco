/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Deterministic content-contamination scan for Myco-managed skills.
 *
 * Skills should encode durable procedures. Point-in-time Myco release,
 * PR/issue, date, branch, session, spore, and decision-state references
 * belong in the vault or in an explicit history section, not in live
 * procedural prose.
 */

export interface SkillContaminationSpan {
  kind: string;
  text: string;
  start: number;
  end: number;
  message: string;
}

export interface SkillContaminationScanResult {
  hard: SkillContaminationSpan[];
  warn: SkillContaminationSpan[];
}

interface Range {
  start: number;
  end: number;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;
const FENCED_CODE_PATTERN = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;
const HISTORY_SECTION_HEADING_PATTERN = /^##\s+(Old patterns|Historical context)\s*$/gim;
const H2_HEADING_PATTERN = /^##\s+/gm;

const PARENTHETICAL_MYCO_VERSION_PATTERN = /\([^)\n]*\bv\d+\.\d+(?:\.\d+)?\+?[^)\n]*\)/gi;
const V_PREFIXED_DOTTED_VERSION_PATTERN = /\bv\d+\.\d+(?:\.\d+)?\+?\b/gi;
const BARE_DOTTED_VERSION_PATTERN = /\b\d+\.\d+\.\d+\b/g;
const REFERENCE_ID_PATTERN = /\bPR\s+#?\d+\b|#\d{2,}\b/g;
const ISO_DATE_PATTERN = /\b20\d{2}-\d{2}-\d{2}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHORT_HEX_ID_PATTERN = /\b[0-9a-f]{8,16}\b/gi;
const TEMPORAL_ADVERB_PATTERN = /\b(?:recently|currently|latest)\b/gi;
const BRANCH_NAME_PATTERN = /\b(?:ck|feat|feature|fix|bugfix|chore|refactor|test|release)\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]\b/g;
const STATE_ID_PATTERN = /\b(?:(?:session|decision|bug[_-]fix|gotcha|wisdom|discovery|trade[_-]off|architecture|pattern)[_-][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*|spore[_-][A-Za-z0-9_-]+[-_][A-Za-z0-9_-]+)\b/gi;
const INVENTED_MYCO_SKILL_LINT_COMMAND_PATTERN = /\bmyco\s+(?:(?:skill|skills)\s+lint|skill-?lint)\b/gi;
const SETTLED_STATUS_ASSIGNMENT_PATTERN = /\bstatus\s*(?:=|:)\s*['"`]?\bsettled\b['"`]?/gi;
const SURVEY_CANDIDATE_STATUS_PATTERNS = [
  /\b(?:skill-?survey|survey)\s+(?:creates?|produces?|generates?|emits?|returns?)\s+(?:pending|approved)\s+candidates?\b/gi,
  /\b(?:generated|created|produced)\s+(?:skill-?survey|survey)\s+candidates?\b[^\n.]{0,120}\b(?:should\s+be|with\s+status|status\s*(?:=|:)|as|are)\s+[`'"-]?(?:pending|approved)\b(?:[^\n.]{0,80}\b(?:or|and)\s+[`'"-]?(?:pending|approved)\b)?/gi,
  /\b(?:skill-?survey|survey)\s+(?:creates?|produces?|generates?|emits?|returns?)\b[^\n.]{0,120}\bcandidates?\b[^\n.]{0,120}\b(?:with\s+status|status\s*(?:=|:)|as|in)\s+[`'"-]?(?:pending|approved)\b/gi,
  /\b(?:skill-?survey|survey)\s+candidates?\b[^\n.]{0,120}\b(?:are|should\s+be)\s+[`'"-]?(?:pending|approved)\b/gi,
];
const SKILL_CANDIDATES_EVIDENCE_METADATA_PATTERN = /\bskill_candidates\.evidence_metadata\b/gi;
const CORRECTIVE_MYCO_SKILL_LINT_CONTEXT_PATTERN = /\b(?:do\s+not|don't|avoid)\s+(?:(?:run|running|using)\s+)?[`'"]?$/i;

const MARKER_PATTERN = /\b(?:as of|since|shipped in|introduced in|added in|landed in|post-?(?:PR|#)|we\s+(?:decided|chose)|superseded[\s\S]{0,40}?\sin|deprecated as of|discovery|new\s+(?:operational\s+)?pattern)\b/gi;
const ARTIFACT_PATTERN = /\bv\d+\.\d+(?:\.\d+)?\+?\b|\bPR\s+#?\d+\b|#\d{2,}\b/gi;
const MARKER_ARTIFACT_WINDOW = 40;

const V_PREFIXED_DOTTED_VERSION_IN_TEXT_PATTERN = /\bv\d+\.\d+(?:\.\d+)?\+?\b/i;
const THIRD_PARTY_VERSION_PREFIX_PATTERNS = [
  /\bnode(?:\.js)?\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bnpm\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bsqlite\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bgithub(?:\s+actions?)?\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bubuntu\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bpython\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bdeploy-pages\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
  /\bupload-pages-artifact\s*(?:version\s*)?(?:\(\s*)?(?:[<>=~^]+|@|:)?\s*$/i,
];

function frontmatterRange(content: string): Range | undefined {
  const match = content.match(FRONTMATTER_PATTERN);
  return match ? { start: 0, end: match[0].length } : undefined;
}

function collectFrontmatterDescriptionRanges(content: string): Range[] {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) return [];

  const body = match[1];
  const bodyStart = match.index + match[0].indexOf(body);
  const linePattern = /[^\n]*(?:\n|$)/g;
  const lines: Array<{ text: string; start: number }> = [];

  for (const lineMatch of body.matchAll(linePattern)) {
    if (lineMatch.index === undefined || lineMatch[0].length === 0) continue;
    const text = lineMatch[0].replace(/\n$/, '');
    lines.push({ text, start: bodyStart + lineMatch.index });
  }

  const ranges: Range[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const description = /^description\s*:\s*(.*)$/.exec(line.text);
    if (!description) continue;

    const value = description[1];
    const valueStart = line.text.indexOf(value);
    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) continue;

    if (/^[>|]/.test(trimmedValue)) {
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex++) {
        const blockLine = lines[blockIndex];
        if (/^[A-Za-z0-9_-]+\s*:/.test(blockLine.text)) break;
        const trimmedLine = blockLine.text.trim();
        if (trimmedLine.length === 0) continue;
        const indentLength = blockLine.text.length - blockLine.text.trimStart().length;
        ranges.push({
          start: blockLine.start + indentLength,
          end: blockLine.start + blockLine.text.length,
        });
      }
      continue;
    }

    const leadingWhitespace = value.length - value.trimStart().length;
    ranges.push({
      start: line.start + valueStart + leadingWhitespace,
      end: line.start + line.text.length,
    });
  }

  return ranges;
}

function subtractRanges(range: Range, exclusions: Range[]): Range[] {
  const sorted = exclusions
    .filter((exclusion) => overlaps(range, exclusion))
    .map((exclusion) => ({
      start: Math.max(range.start, exclusion.start),
      end: Math.min(range.end, exclusion.end),
    }))
    .sort((a, b) => a.start - b.start);

  const result: Range[] = [];
  let cursor = range.start;
  for (const exclusion of sorted) {
    if (cursor < exclusion.start) result.push({ start: cursor, end: exclusion.start });
    cursor = Math.max(cursor, exclusion.end);
  }
  if (cursor < range.end) result.push({ start: cursor, end: range.end });
  return result;
}

function collectRegexRanges(content: string, pattern: RegExp): Range[] {
  const ranges: Range[] = [];
  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function collectHistorySectionRanges(content: string): Range[] {
  const ranges: Range[] = [];
  for (const match of content.matchAll(HISTORY_SECTION_HEADING_PATTERN)) {
    if (match.index === undefined) continue;
    H2_HEADING_PATTERN.lastIndex = match.index + match[0].length;
    const next = H2_HEADING_PATTERN.exec(content);
    ranges.push({
      start: match.index,
      end: next?.index ?? content.length,
    });
  }
  H2_HEADING_PATTERN.lastIndex = 0;
  return ranges;
}

function maskIgnoredRanges(content: string, ranges: Range[]): string {
  const chars = content.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index++) {
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function overlaps(range: Range, other: Range): boolean {
  return range.start < other.end && other.start < range.end;
}

function overlapsAny(range: Range, ranges: Range[]): boolean {
  return ranges.some((candidate) => overlaps(range, candidate));
}

function addSpan(
  spans: SkillContaminationSpan[],
  existingRanges: Range[],
  kind: string,
  content: string,
  start: number,
  end: number,
  message: string,
): boolean {
  const range = { start, end };
  if (overlapsAny(range, existingRanges)) return false;
  spans.push({
    kind,
    text: content.slice(start, end),
    start,
    end,
    message,
  });
  existingRanges.push(range);
  return true;
}

function allowlistedThirdPartyVersion(content: string, start: number, end: number): boolean {
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextNewline = content.indexOf('\n', end);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  const line = content.slice(lineStart, lineEnd);
  const beforeVersion = line.slice(0, start - lineStart);
  return THIRD_PARTY_VERSION_PREFIX_PATTERNS.some((pattern) => pattern.test(beforeVersion));
}

function regexMatches(content: string, pattern: RegExp): Range[] {
  const matches: Range[] = [];
  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined) continue;
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function shouldSkipBareDottedVersion(content: string, start: number): boolean {
  const prior = content[start - 1];
  return prior === 'v' || prior === 'V' || prior === '.' || /\d/.test(prior ?? '');
}

function hasNegatedInstructionContext(content: string, start: number): boolean {
  const lineStart = content.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const before = content.slice(lineStart, start).toLowerCase();
  return CORRECTIVE_MYCO_SKILL_LINT_CONTEXT_PATTERN.test(before);
}

function addSemanticContractFindings(
  content: string,
  searchable: string,
  hard: SkillContaminationSpan[],
  excludedRanges: Range[],
): void {
  const occupied: Range[] = [...excludedRanges];

  for (const match of searchable.matchAll(INVENTED_MYCO_SKILL_LINT_COMMAND_PATTERN)) {
    if (match.index === undefined) continue;
    if (hasNegatedInstructionContext(content, match.index)) continue;
    addSpan(
      hard,
      occupied,
      'invented-myco-skill-lint-command',
      content,
      match.index,
      match.index + match[0].length,
      'Myco has no `myco skill lint` command; use `npm run lint:skills:strict -- --json` for strict skill linting.',
    );
  }

  for (const match of searchable.matchAll(SETTLED_STATUS_ASSIGNMENT_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      hard,
      occupied,
      'invalid-session-status',
      content,
      match.index,
      match.index + match[0].length,
      'Session lifecycle status `settled` does not exist; refer to settled/non-active sessions as completed or non-active/completed.',
    );
  }

  for (const pattern of SURVEY_CANDIDATE_STATUS_PATTERNS) {
    for (const match of searchable.matchAll(pattern)) {
      if (match.index === undefined) continue;
      addSpan(
        hard,
        occupied,
        'invalid-survey-candidate-status',
        content,
        match.index,
        match.index + match[0].length,
        'skill-survey creates candidates with status `identified`; `approved` is a later human/dashboard transition and `pending` is not the survey-created state.',
      );
    }
  }

  for (const match of searchable.matchAll(SKILL_CANDIDATES_EVIDENCE_METADATA_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      hard,
      occupied,
      'invalid-skill-candidate-field',
      content,
      match.index,
      match.index + match[0].length,
      '`skill_candidates.evidence_metadata` does not exist; use the actual skill candidate evidence fields such as source_ids, evidence_bundle_id, quality_score, quality_failures, and coverage_matches.',
    );
  }
}

export function scanForContamination(content: string): SkillContaminationScanResult {
  const frontmatter = frontmatterRange(content);
  const frontmatterDescriptionRanges = collectFrontmatterDescriptionRanges(content);
  const nonDescriptionFrontmatterRanges = frontmatter
    ? subtractRanges(frontmatter, frontmatterDescriptionRanges)
    : [];
  const ignoredRanges = [
    ...nonDescriptionFrontmatterRanges,
    ...collectRegexRanges(content, FENCED_CODE_PATTERN),
    ...collectRegexRanges(content, INLINE_CODE_PATTERN),
    ...collectHistorySectionRanges(content),
  ];
  const semanticIgnoredRanges = [
    ...nonDescriptionFrontmatterRanges,
    ...collectRegexRanges(content, FENCED_CODE_PATTERN),
    ...collectHistorySectionRanges(content),
  ];
  const searchable = maskIgnoredRanges(content, ignoredRanges);
  const semanticSearchable = maskIgnoredRanges(content, semanticIgnoredRanges);
  const hard: SkillContaminationSpan[] = [];
  const warn: SkillContaminationSpan[] = [];
  const occupied: Range[] = [...ignoredRanges];

  addSemanticContractFindings(content, semanticSearchable, hard, semanticIgnoredRanges);

  for (const match of searchable.matchAll(PARENTHETICAL_MYCO_VERSION_PATTERN)) {
    if (match.index === undefined) continue;
    const versionMatch = match[0].match(V_PREFIXED_DOTTED_VERSION_IN_TEXT_PATTERN);
    if (versionMatch?.index !== undefined) {
      const start = match.index + versionMatch.index;
      const end = start + versionMatch[0].length;
      if (allowlistedThirdPartyVersion(content, start, end)) {
        addSpan(
          warn,
          occupied,
          'third-party-version',
          content,
          start,
          end,
          'Version-looking third-party reference; live skill writes require durable constraint language or an explicit history section.',
        );
        continue;
      }
    }
    addSpan(
      hard,
      occupied,
      'myco-version-parenthetical',
      content,
      match.index,
      match.index + match[0].length,
      'Parenthetical Myco release tags are point-in-time state, not durable skill procedure.',
    );
  }

  for (const match of searchable.matchAll(V_PREFIXED_DOTTED_VERSION_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (allowlistedThirdPartyVersion(content, start, end)) {
      addSpan(
        warn,
        occupied,
        'third-party-version',
        content,
        start,
        end,
        'Version-looking third-party reference; live skill writes require durable constraint language or an explicit history section.',
      );
      continue;
    }
    addSpan(
      hard,
      occupied,
      'myco-version',
      content,
      start,
      end,
      'V-prefixed dotted versions are Myco release-state references and must live in Myco, not skill prose.',
    );
  }

  const markers = regexMatches(searchable, MARKER_PATTERN);
  const artifacts = regexMatches(searchable, ARTIFACT_PATTERN);
  for (const marker of markers) {
    const artifact = artifacts.find((candidate) => {
      if (candidate.start >= marker.end) {
        return candidate.start - marker.end <= MARKER_ARTIFACT_WINDOW;
      }
      return marker.start - candidate.end <= MARKER_ARTIFACT_WINDOW;
    });
    if (!artifact) continue;
    const start = Math.min(marker.start, artifact.start);
    const end = Math.max(marker.end, artifact.end);
    addSpan(
      hard,
      occupied,
      'marker-artifact',
      content,
      start,
      end,
      'Temporal/history marker appears near a release, PR, or issue artifact.',
    );
  }

  for (const match of searchable.matchAll(BRANCH_NAME_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      hard,
      occupied,
      'branch-name',
      content,
      match.index,
      match.index + match[0].length,
      'Branch names are point-in-time implementation state, not durable skill procedure.',
    );
  }

  for (const match of searchable.matchAll(STATE_ID_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      hard,
      occupied,
      'state-id',
      content,
      match.index,
      match.index + match[0].length,
      'Session, spore, and decision-state IDs must live in Myco evidence, not skill prose.',
    );
  }

  for (const match of searchable.matchAll(BARE_DOTTED_VERSION_PATTERN)) {
    if (match.index === undefined || shouldSkipBareDottedVersion(content, match.index)) continue;
    addSpan(
      warn,
      occupied,
      'third-party-version',
      content,
      match.index,
      match.index + match[0].length,
      'Bare dotted version references are point-in-time state unless framed as durable requirements or kept in an explicit history section.',
    );
  }

  for (const match of searchable.matchAll(REFERENCE_ID_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      warn,
      occupied,
      'reference-id',
      content,
      match.index,
      match.index + match[0].length,
      'Bare PR/issue references are historical state; move or remove them before live skill writes.',
    );
  }

  for (const match of searchable.matchAll(ISO_DATE_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      warn,
      occupied,
      'date',
      content,
      match.index,
      match.index + match[0].length,
      'Dates in skill prose usually rot; move point-in-time state into Myco or explicit history before live skill writes.',
    );
  }

  for (const match of searchable.matchAll(UUID_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      warn,
      occupied,
      'uuid',
      content,
      match.index,
      match.index + match[0].length,
      'UUID references are usually vault/session state, not durable procedure.',
    );
  }

  for (const match of searchable.matchAll(SHORT_HEX_ID_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      warn,
      occupied,
      'short-id',
      content,
      match.index,
      match.index + match[0].length,
      'Short hex IDs are usually commit/session/spore state, not durable procedure.',
    );
  }

  for (const match of searchable.matchAll(TEMPORAL_ADVERB_PATTERN)) {
    if (match.index === undefined) continue;
    addSpan(
      warn,
      occupied,
      'temporal-adverb',
      content,
      match.index,
      match.index + match[0].length,
      'Temporal phrasing ages quickly; make live skill procedure timeless before writing.',
    );
  }

  return { hard, warn };
}
