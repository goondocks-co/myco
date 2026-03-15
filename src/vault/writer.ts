import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { buildTags, formatTeamBody, formatPlanBody, formatArtifactBody } from '../obsidian/formatter.js';
import type { ArtifactType } from './types.js';
import { sessionNoteId, sessionRelativePath } from './session-id.js';

interface WriteSessionInput {
  id: string;
  agent?: string;
  user?: string;
  started: string;
  ended?: string;
  parent?: string;
  parent_reason?: string;
  plans?: string[];
  branch?: string;
  tags?: string[];
  tools_used?: number;
  files_changed?: number;
  summary: string;
}

interface WritePlanInput {
  id: string;
  status?: string;
  author?: string;
  tags?: string[];
  content: string;
}

interface WriteMemoryInput {
  id: string;
  observation_type: string;
  session?: string;
  plan?: string;
  tags?: string[];
  content: string;
}

interface WriteArtifactInput {
  id: string;
  artifact_type: ArtifactType;
  source_path: string;
  title: string;
  session: string;
  tags?: string[];
  content: string;
}

interface WriteTeamMemberInput {
  user: string;
  role?: string;
}

export class VaultWriter {
  constructor(private vaultDir: string) {}

  writeSession(input: WriteSessionInput): string {
    const date = input.started.slice(0, 10);
    const relativePath = sessionRelativePath(input.id, date);

    const frontmatter: Record<string, unknown> = {
      type: 'session',
      id: input.id,
      agent: input.agent ?? 'claude-code',
      user: input.user ?? '',
      started: input.started,
    };
    if (input.ended) frontmatter.ended = input.ended;
    if (input.parent) frontmatter.parent = input.parent;
    if (input.parent_reason) frontmatter.parent_reason = input.parent_reason;
    if (input.plans?.length) frontmatter.plans = input.plans;
    if (input.branch) frontmatter.branch = input.branch;
    frontmatter.tags = buildTags('session', 'ended', [
      ...(input.user ? [`user/${input.user}`] : []),
      ...(input.tags ?? []),
    ]);
    if (input.tools_used != null) frontmatter.tools_used = input.tools_used;
    if (input.files_changed != null) frontmatter.files_changed = input.files_changed;

    this.writeMarkdown(relativePath, frontmatter, input.summary);
    return relativePath;
  }

  writePlan(input: WritePlanInput): string {
    const relativePath = `plans/${input.id}.md`;

    const status = input.status ?? 'active';
    const created = new Date().toISOString();
    const frontmatter: Record<string, unknown> = {
      type: 'plan',
      id: input.id,
      status,
      created,
    };
    if (input.author) frontmatter.author = input.author;
    frontmatter.tags = buildTags('plan', status, input.tags ?? []);

    const body = formatPlanBody({
      id: input.id,
      status,
      author: input.author,
      created,
      content: input.content,
      tags: input.tags,
    });

    this.writeMarkdown(relativePath, frontmatter, body);
    return relativePath;
  }

  writeMemory(input: WriteMemoryInput): string {
    const normalizedType = input.observation_type.replace(/_/g, '-');
    const relativePath = `memories/${normalizedType}/${input.id}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'memory',
      id: input.id,
      observation_type: input.observation_type,
      created: new Date().toISOString(),
    };
    if (input.session) frontmatter.session = input.session;
    if (input.plan) frontmatter.plan = input.plan;
    frontmatter.tags = buildTags('memory', input.observation_type, input.tags ?? []);

    this.writeMarkdown(relativePath, frontmatter, input.content);
    return relativePath;
  }

  writeArtifact(input: WriteArtifactInput): string {
    const relativePath = `artifacts/${input.id}.md`;
    const fullPath = path.join(this.vaultDir, relativePath);
    const now = new Date().toISOString();

    let created = now;

    // Preserve created from existing file (latest-wins update)
    try {
      const existing = fs.readFileSync(fullPath, 'utf-8');
      const fmMatch = existing.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
        if (typeof parsed.created === 'string') created = parsed.created;
      }
    } catch {
      // File doesn't exist yet — created = now
    }

    const frontmatter: Record<string, unknown> = {
      type: 'artifact',
      id: input.id,
      artifact_type: input.artifact_type,
      source_path: input.source_path,
      title: input.title,
      last_captured_by: sessionNoteId(input.session),
      created,
      updated: now,
      tags: buildTags('artifact', input.artifact_type, input.tags ?? []),
    };

    const body = formatArtifactBody({
      id: input.id,
      title: input.title,
      artifact_type: input.artifact_type,
      source_path: input.source_path,
      sessionId: input.session,
      content: input.content,
      tags: input.tags,
    });

    this.writeMarkdown(relativePath, frontmatter, body);
    return relativePath;
  }

  writeTeamMember(input: WriteTeamMemberInput): string {
    const relativePath = `team/${input.user}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'team-member',
      user: input.user,
      joined: new Date().toISOString(),
      tags: buildTags('team', '', [`user/${input.user}`]),
    };
    if (input.role) frontmatter.role = input.role;

    const body = formatTeamBody({
      user: input.user,
      role: input.role,
    });

    this.writeMarkdown(relativePath, frontmatter, body);
    return relativePath;
  }

  /**
   * Update frontmatter fields on an existing note without touching the body.
   * By default only adds fields that don't exist. Set overwrite=true to replace existing values.
   * Returns true if the update was applied, false if the file doesn't exist.
   */
  updateNoteFrontmatter(relativePath: string, fields: Record<string, unknown>, overwrite = false): boolean {
    const fullPath = path.join(this.vaultDir, relativePath);
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return false;
    }

    const fmMatch = fileContent.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return false;

    const parsed = YAML.parse(fmMatch[1]) as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      if (overwrite || parsed[key] === undefined) {
        parsed[key] = value;
      }
    }

    const body = fileContent.slice(fmMatch[0].length);
    const fmYaml = YAML.stringify(parsed, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trim();
    fs.writeFileSync(fullPath, `---\n${fmYaml}\n---${body}`, 'utf-8');
    return true;
  }

  /** @deprecated Use updateNoteFrontmatter instead */
  updateSessionFrontmatter(relativePath: string, fields: Record<string, unknown>): boolean {
    return this.updateNoteFrontmatter(relativePath, fields);
  }

  private writeMarkdown(relativePath: string, frontmatter: Record<string, unknown>, content: string): void {
    const fullPath = path.join(this.vaultDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fmYaml = YAML.stringify(frontmatter, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trim();
    const file = `---\n${fmYaml}\n---\n\n${content}\n`;
    fs.writeFileSync(fullPath, file, 'utf-8');
  }
}
