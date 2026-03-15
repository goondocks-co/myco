/**
 * Pure formatting functions for Obsidian-native vault notes.
 * No I/O, no external dependencies — just string transforms.
 */
import type { ArtifactType } from '../vault/types.js';
import { sessionNoteId } from '../vault/session-id.js';

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

export function callout(type: string, title: string, content: string): string {
  const indented = content.split('\n').map((line) => `> ${line}`).join('\n');
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
    aiResponse?: string;
  }>;
  existingTurnCount?: number;
  existingConversation?: string;
  tags?: string[];
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

  // Related memories
  if (input.relatedMemories?.length) {
    const links = input.relatedMemories.map((m) => `- ${wikilink(m.id, m.title)}`);
    sections.push(`## Related Memories\n${links.join('\n')}`);
  }

  // Conversation turns — preserve existing + append new
  if (input.existingConversation) {
    // Existing conversation already has ## Conversation heading and prior turns.
    // Format new turns and append.
    const newTurnLines: string[] = [];
    const startNum = (input.existingTurnCount ?? 0) + 1;
    for (let i = 0; i < input.turns.length; i++) {
      const turn = input.turns[i];
      const turnNum = startNum + i;
      newTurnLines.push(`### Turn ${turnNum}`);
      if (turn.prompt) {
        newTurnLines.push(callout('user', 'Prompt', turn.prompt));
      }
      if (turn.toolCount > 0) {
        newTurnLines.push(`**Tools**: ${turn.toolCount} calls`);
      }
      if (turn.aiResponse) {
        newTurnLines.push(callout('assistant', 'Response', turn.aiResponse));
      }
    }
    if (newTurnLines.length > 0) {
      sections.push(input.existingConversation.replace(/\n+$/, '') + '\n\n' + newTurnLines.join('\n\n'));
    } else {
      sections.push(input.existingConversation);
    }
  } else {
    // First write — generate conversation from scratch
    const turnLines: string[] = [];
    for (let i = 0; i < input.turns.length; i++) {
      const turn = input.turns[i];
      const turnNum = i + 1;
      turnLines.push(`### Turn ${turnNum}`);
      if (turn.prompt) {
        turnLines.push(callout('user', 'Prompt', turn.prompt));
      }
      if (turn.toolCount > 0) {
        turnLines.push(`**Tools**: ${turn.toolCount} calls`);
      }
      if (turn.aiResponse) {
        turnLines.push(callout('assistant', 'Response', turn.aiResponse));
      }
    }
    if (turnLines.length > 0) {
      sections.push(`## Conversation\n\n${turnLines.join('\n\n')}`);
    }
  }

  // Footer tags
  const allTags = buildTags('session', 'ended', [
    ...(input.user ? [`user/${input.user}`] : []),
    ...(input.tags ?? []),
  ]);
  sections.push(footerTags(allTags));

  return sections.join('\n\n');
}

// --- Memory formatting ---

export interface MemoryBodyInput {
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

export function formatMemoryBody(input: MemoryBodyInput): string {
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
  const allTags = buildTags('memory', input.observationType, input.tags ?? []);
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
