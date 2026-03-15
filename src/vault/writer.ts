import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

interface WriteSessionInput {
  id: string;
  agent?: string;
  user?: string;
  started: string;
  ended?: string;
  parent?: string;
  plan?: string;
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

interface WriteArtifactRefInput {
  id: string;
  source: string;
  artifact_type: string;
  detected_via: string;
  session?: string;
  tags?: string[];
  copySource?: boolean;
  projectRoot?: string;
}

interface WriteTeamMemberInput {
  user: string;
  role?: string;
}

export class VaultWriter {
  constructor(private vaultDir: string) {}

  writeSession(input: WriteSessionInput): string {
    const date = input.started.slice(0, 10);
    const relativePath = `sessions/${date}/session-${input.id}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'session',
      id: input.id,
      agent: input.agent ?? 'claude-code',
      user: input.user ?? '',
      started: input.started,
    };
    if (input.ended) frontmatter.ended = input.ended;
    if (input.parent) frontmatter.parent = input.parent;
    if (input.plan) frontmatter.plan = input.plan;
    if (input.branch) frontmatter.branch = input.branch;
    if (input.tags?.length) frontmatter.tags = input.tags;
    if (input.tools_used != null) frontmatter.tools_used = input.tools_used;
    if (input.files_changed != null) frontmatter.files_changed = input.files_changed;

    this.writeMarkdown(relativePath, frontmatter, input.summary);
    return relativePath;
  }

  writePlan(input: WritePlanInput): string {
    const relativePath = `plans/${input.id}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'plan',
      id: input.id,
      status: input.status ?? 'active',
      created: new Date().toISOString(),
    };
    if (input.author) frontmatter.author = input.author;
    if (input.tags?.length) frontmatter.tags = input.tags;

    this.writeMarkdown(relativePath, frontmatter, input.content);
    return relativePath;
  }

  writeMemory(input: WriteMemoryInput): string {
    const relativePath = `memories/${input.id}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'memory',
      id: input.id,
      observation_type: input.observation_type,
      created: new Date().toISOString(),
    };
    if (input.session) frontmatter.session = input.session;
    if (input.plan) frontmatter.plan = input.plan;
    if (input.tags?.length) frontmatter.tags = input.tags;

    this.writeMarkdown(relativePath, frontmatter, input.content);
    return relativePath;
  }

  writeArtifactRef(input: WriteArtifactRefInput): string {
    const relativePath = `artifacts/${input.id}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'artifact-ref',
      source: input.source,
      artifact_type: input.artifact_type,
      detected_via: input.detected_via,
      created: new Date().toISOString(),
    };
    if (input.session) frontmatter.session = input.session;
    if (input.tags?.length) frontmatter.tags = input.tags;

    let body = `External artifact: \`${input.source}\``;

    if (input.copySource) {
      const absSource = input.projectRoot
        ? path.resolve(input.projectRoot, input.source)
        : input.source;
      if (fs.existsSync(absSource)) {
        const sourceContent = fs.readFileSync(absSource, 'utf-8');
        body = sourceContent;
      }
    }

    this.writeMarkdown(relativePath, frontmatter, body);
    return relativePath;
  }

  writeTeamMember(input: WriteTeamMemberInput): string {
    const relativePath = `team/${input.user}.md`;

    const frontmatter: Record<string, unknown> = {
      type: 'team-member',
      user: input.user,
      joined: new Date().toISOString(),
    };
    if (input.role) frontmatter.role = input.role;

    this.writeMarkdown(relativePath, frontmatter, `# ${input.user}\n\nTeam member.`);
    return relativePath;
  }

  private writeMarkdown(relativePath: string, frontmatter: Record<string, unknown>, content: string): void {
    const fullPath = path.join(this.vaultDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    const fmYaml = YAML.stringify(frontmatter, { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trim();
    const file = `---\n${fmYaml}\n---\n\n${content}\n`;
    fs.writeFileSync(fullPath, file, 'utf-8');
  }
}
