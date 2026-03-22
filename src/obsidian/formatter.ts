/**
 * Pure formatting functions for Obsidian-native vault notes.
 * No I/O, no external dependencies — just string transforms.
 */
import type { ArtifactType } from '../vault/types.js';
import { sessionNoteId } from '../vault/session-id.js';
import { TURN_MAX_FILES_DISPLAYED } from '../constants.js';

/** Section heading for conversation content in session notes. */
export const CONVERSATION_HEADING = '## Conversation';

/** Prefix for turn headings in session notes. Used for boundary detection during truncation. */
export const TURN_HEADING_PREFIX = '\n### Turn ';

// Callout type mapping for observation types
const CALLOUT_MAP: Record<string, string> = {
  gotcha: 'warning',
  bug_fix: 'bug',
  decision: 'info',
  discovery: 'tip',
  trade_off: 'question',
};

export function observationCalloutType(observationType: string): string {
  return CALLOUT_MAP[observationType] ?? 'note';
}

/**
 * Escape angle brackets that Obsidian would interpret as HTML tags.
 * Matches `<` followed by a letter, `/`, or `!` (opening/closing tags, comments).
 */
export function escapeHtmlTags(text: string): string {
  return text.replace(/<(?=[a-zA-Z/!])/g, '\\<');
}

export function callout(type: string, title: string, content: string): string {
  const safe = escapeHtmlTags(content);
  const indented = safe.split('\n').map((line) => `> ${line}`).join('\n');
  return `> [!${type}] ${title}\n${indented}`;
}

export function inlineField(key: string, value: string): string {
  return `${key}:: ${value}`;
}

export function wikilink(target: string, display?: string): string {
  return display ? `[[${target}|${display}]]` : `[[${target}]]`;
}

/**
 * Normalize an observation_type to a tag-safe form.
 * Frontmatter keeps underscores; tags use hyphens per Obsidian convention.
 */
function tagNormalize(s: string): string {
  return s.replace(/_/g, '-');
}

/**
 * Sanitize a user/LLM-provided tag for Obsidian compatibility.
 * Obsidian tags cannot contain spaces — replace with slash (nested tag).
 * Strips leading # if present.
 */
function sanitizeTag(raw: string): string {
  const stripped = raw.startsWith('#') ? raw.slice(1) : raw;
  return stripped.replace(/\s+/g, '/');
}

export function buildTags(type: string, subtype: string, extraTags: string[] = []): string[] {
  const tags: string[] = [`type/${type}`];

  if (subtype) {
    tags.push(`${type}/${tagNormalize(subtype)}`);
  }

  for (const tag of extraTags) {
    const normalized = sanitizeTag(tag);
    if (normalized && !tags.includes(normalized)) {
      tags.push(normalized);
    }
  }

  return tags;
}

export function footerTags(tags: string[]): string {
  return tags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ');
}

// --- Session formatting ---

export interface SessionBodyInput {
  title: string;
  narrative: string;
  sessionId: string;
  user?: string;
  started?: string;
  ended?: string;
  branch?: string;
  relatedMemories?: Array<{ id: string; title: string }>;
  turns: Array<{
    prompt: string;
    toolCount: number;
    toolBreakdown?: Record<string, number>;
    files?: string[];
    aiResponse?: string;
    /** Filenames of images in the vault attachments folder */
    images?: string[];
  }>;
  tags?: string[];
}

function formatToolAndFiles(turn: { toolCount: number; toolBreakdown?: Record<string, number>; files?: string[] }): string[] {
  const parts: string[] = [];
  if (turn.toolCount > 0) {
    if (turn.toolBreakdown && Object.keys(turn.toolBreakdown).length > 0) {
      const sorted = Object.entries(turn.toolBreakdown).sort((a, b) => b[1] - a[1]);
      const breakdown = sorted.map(([name, count]) => `${name} (${count})`).join(', ');
      parts.push(`*${turn.toolCount} tool calls: ${breakdown}*`);
    } else {
      parts.push(`*${turn.toolCount} tool calls*`);
    }
  }
  if (turn.files && turn.files.length > 0) {
    const displayed = turn.files.slice(0, TURN_MAX_FILES_DISPLAYED);
    const suffix = turn.files.length > TURN_MAX_FILES_DISPLAYED
      ? ` +${turn.files.length - TURN_MAX_FILES_DISPLAYED} more`
      : '';
    parts.push(`*Files: ${displayed.join(', ')}${suffix}*`);
  }
  return parts;
}

export function formatSessionBody(input: SessionBodyInput): string {
  const sections: string[] = [];

  sections.push(`# ${input.title}`);

  if (input.narrative) {
    sections.push(callout('abstract', 'Summary', input.narrative));
  }

  // Inline fields
  const fields: string[] = [];
  fields.push(inlineField('Session', wikilink(sessionNoteId(input.sessionId))));
  if (input.user) fields.push(inlineField('User', input.user));
  if (input.started && input.ended) {
    const duration = formatDuration(input.started, input.ended);
    if (duration) fields.push(inlineField('Duration', duration));
  }
  if (input.branch) fields.push(inlineField('Branch', `\`${input.branch}\``));
  sections.push(fields.join('\n'));

  // Related spores
  if (input.relatedMemories?.length) {
    const links = input.relatedMemories.map((m) => `- ${wikilink(m.id, m.title)}`);
    sections.push(`## Related Spores\n${links.join('\n')}`);
  }

  // Conversation turns — always rebuilt from the full transcript.
  // The transcript is the source of truth for the complete conversation.
  if (input.turns.length > 0) {
    const turnLines: string[] = [];
    for (let i = 0; i < input.turns.length; i++) {
      const turn = input.turns[i];
      const turnNum = i + 1;
      turnLines.push(`### Turn ${turnNum}`);
      {
        const parts: string[] = [];
        if (turn.prompt) parts.push(turn.prompt);
        if (turn.images?.length) {
          parts.push(turn.images.map((f) => `![[${f}]]`).join('\n'));
        }
        parts.push(...formatToolAndFiles(turn));
        if (parts.length > 0) {
          turnLines.push(callout('user', 'Prompt', parts.join('\n\n')));
        }
      }
      if (turn.aiResponse) {
        turnLines.push(callout('assistant', 'Response', turn.aiResponse));
      }
    }
    sections.push(`${CONVERSATION_HEADING}\n\n${turnLines.join('\n\n')}`);
  }

  // Footer tags
  const allTags = buildTags('session', 'ended', [
    ...(input.user ? [`user/${input.user}`] : []),
    ...(input.tags ?? []),
  ]);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Spore formatting ---

export interface SporeBodyInput {
  title: string;
  observationType: string;
  content: string;
  sessionId?: string;
  root_cause?: string;
  fix?: string;
  rationale?: string;
  alternatives_rejected?: string;
  gained?: string;
  sacrificed?: string;
  tags?: string[];
}

export function formatSporeBody(input: SporeBodyInput): string {
  const sections: string[] = [];
  const calloutType = observationCalloutType(input.observationType);
  const calloutTitle = capitalize(tagNormalize(input.observationType));

  sections.push(`# ${input.title}`);
  sections.push(callout(calloutType, calloutTitle, input.content));

  // Inline fields
  const fields: string[] = [];
  if (input.sessionId) {
    fields.push(inlineField('Session', wikilink(sessionNoteId(input.sessionId))));
  }
  fields.push(inlineField('Observation', input.observationType));
  if (fields.length > 0) sections.push(fields.join('\n'));

  // Type-specific sub-sections
  if (input.root_cause) sections.push(`## Root Cause\n${input.root_cause}`);
  if (input.fix) sections.push(`## Fix\n${input.fix}`);
  if (input.rationale) sections.push(`## Rationale\n${input.rationale}`);
  if (input.alternatives_rejected) sections.push(`## Alternatives Rejected\n${input.alternatives_rejected}`);
  if (input.gained) sections.push(`## Gained\n${input.gained}`);
  if (input.sacrificed) sections.push(`## Sacrificed\n${input.sacrificed}`);

  // Footer tags
  const allTags = buildTags('spore', input.observationType, input.tags ?? []);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Plan formatting ---

export interface PlanBodyInput {
  id: string;
  status: string;
  author?: string;
  created?: string;
  sessions?: Array<{ id: string; title: string }>;
  content: string;
  tags?: string[];
}

export function formatPlanBody(input: PlanBodyInput): string {
  const sections: string[] = [];

  // Inline fields block
  const fields: string[] = [];
  fields.push(inlineField('Plan', wikilink(input.id)));
  fields.push(inlineField('Status', input.status));
  if (input.author) fields.push(inlineField('Author', input.author));
  if (input.created) fields.push(inlineField('Created', input.created));
  sections.push(fields.join('\n'));

  // User-provided content body (don't restructure)
  sections.push(input.content);

  // Sessions section
  if (input.sessions?.length) {
    const links = input.sessions.map((s) => `- ${wikilink(sessionNoteId(s.id), s.title)}`);
    sections.push(`## Sessions\n${links.join('\n')}`);
  }

  // Footer tags
  const statusTag = tagNormalize(input.status);
  const allTags = buildTags('plan', statusTag, input.tags ?? []);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Artifact formatting ---

export interface ArtifactBodyInput {
  id: string;
  title: string;
  artifact_type: ArtifactType;
  source_path: string;
  sessionId: string;
  content: string;
  tags?: string[];
}

export function formatArtifactBody(input: ArtifactBodyInput): string {
  const sections: string[] = [];

  // Inline fields
  const fields: string[] = [];
  fields.push(inlineField('Artifact', wikilink(input.id)));
  fields.push(inlineField('Source', `\`${input.source_path}\``));
  fields.push(inlineField('Type', input.artifact_type));
  fields.push(inlineField('Session', wikilink(sessionNoteId(input.sessionId))));
  sections.push(fields.join('\n'));

  // Body: full content from disk
  sections.push(input.content);

  // Footer tags
  const allTags = buildTags('artifact', input.artifact_type, input.tags ?? []);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Team formatting ---

export interface TeamBodyInput {
  user: string;
  role?: string;
  recentSessions?: Array<{ id: string; title: string }>;
}

export function formatTeamBody(input: TeamBodyInput): string {
  const sections: string[] = [];

  sections.push(`# ${input.user}`);
  sections.push(callout('info', 'Team Member', input.role ?? 'Contributor'));

  // Inline fields
  const fields: string[] = [];
  fields.push(inlineField('User', input.user));
  if (input.role) fields.push(inlineField('Role', input.role));
  sections.push(fields.join('\n'));

  // Recent sessions
  if (input.recentSessions?.length) {
    const links = input.recentSessions.map((s) => `- ${wikilink(sessionNoteId(s.id), s.title)}`);
    sections.push(`## Recent Sessions\n${links.join('\n')}`);
  }

  // Footer tags
  const allTags = buildTags('team', '', [`user/${input.user}`]);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Section extraction ---

/** Footer tag prefix used to terminate section extraction. */
const FOOTER_TAG_PREFIX = '\n#type/';

/**
 * Extract a named section from a session/spore note body.
 * Returns content between the section heading and the footer tags.
 */
export function extractSection(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) return '';
  const section = body.slice(start + heading.length);
  const footerIdx = section.lastIndexOf(FOOTER_TAG_PREFIX);
  if (footerIdx !== -1) return section.slice(0, footerIdx).trim();
  return section.trim();
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDuration(started: string, ended: string): string {
  const ms = new Date(ended).getTime() - new Date(started).getTime();
  if (isNaN(ms) || ms < 0) return '';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
