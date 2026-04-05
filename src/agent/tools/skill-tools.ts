/**
 * Skill lifecycle vault tools.
 *
 * 3 tools: vault_skill_candidates, vault_skill_records, vault_write_skill
 */

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import {
  insertCandidate, getCandidate, listCandidates, updateCandidate, deleteCandidate,
} from '@myco/db/queries/skill-candidates.js';
import {
  insertSkillRecord, getSkillRecord, getSkillRecordByName,
  listSkillRecords, updateSkillRecord, deleteSkillRecordCascade,
} from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { notify } from '@myco/notifications/notify.js';
import { validateSkillContent } from './skill-validator.js';
import { textResult, type VaultToolDeps } from './types.js';

// ---------------------------------------------------------------------------
// Frontmatter preservation
// ---------------------------------------------------------------------------

/** Fields that must not change when updating an existing skill. */
const PROTECTED_FRONTMATTER_FIELDS = ['user-invocable', 'allowed-tools'] as const;

/**
 * Extract a frontmatter field value from SKILL.md content.
 * Returns the raw value string, or undefined if not found.
 */
function extractFrontmatterField(content: string, field: string): string | undefined {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const match = fmMatch[1].match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return match?.[1].trim();
}

/**
 * Compare protected frontmatter fields between existing and new content.
 * Returns an array of violation descriptions (empty = all preserved).
 */
function checkFrontmatterPreservation(existing: string, incoming: string): string[] {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillTools(deps: VaultToolDeps) {
  const { agentId, machineId, projectRoot, vaultDir, recordTurn } = deps;

  const vaultSkillCandidates = tool(
    'vault_skill_candidates',
    'Manage skill candidates (identified topics that may become skills). Supports list, get, create, and update actions.',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Candidate ID (required for get/update)'),
      topic: z.string().optional().describe('Skill topic (required for create)'),
      rationale: z.string().optional().describe('Why this should be a skill (required for create)'),
      confidence: z.number().optional().describe('Confidence score 0-1'),
      status: z.enum(['identified', 'approved', 'generated', 'dismissed']).optional().describe('Candidate status. Only these values are valid.'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      skill_id: z.string().optional().describe('Associated skill record ID (after materialization)'),
      limit: z.number().optional().describe('Maximum candidates to return (for list)'),
    },
    async (args) => {
      recordTurn('vault_skill_candidates', args);

      switch (args.action) {
        case 'list': {
          const candidates = listCandidates({
            agent_id: agentId,
            status: args.status,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(candidates);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const candidate = getCandidate(args.id);
          if (!candidate) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult(candidate);
        }

        case 'create': {
          if (!args.topic || !args.rationale) {
            return textResult({ error: 'topic and rationale are required for create action' });
          }

          // Guard: reject if an active skill already covers this topic.
          // Checks whether all significant words from a skill name appear in the topic.
          const activeSkills = listSkillRecords({ agent_id: agentId, status: 'active', limit: 100 });
          const topicLower = args.topic.toLowerCase();
          const overlapping = activeSkills.filter((s) => {
            const nameWords = s.name.split('-').filter((w: string) => w.length > 2);
            if (nameWords.length < 2) return false;
            return nameWords.every((w: string) => topicLower.includes(w));
          });
          if (overlapping.length > 0) {
            return textResult({
              error: 'Candidate rejected: active skill(s) already cover this topic. Update the existing skill via vault_skill_records instead.',
              overlapping_skills: overlapping.map((s) => ({ name: s.name, display_name: s.display_name, description: s.description })),
            });
          }

          const now = epochSeconds();
          const candidate = insertCandidate({
            id: crypto.randomUUID(),
            agent_id: agentId,
            machine_id: machineId,
            topic: args.topic,
            rationale: args.rationale,
            confidence: args.confidence,
            status: args.status,
            source_ids: args.source_ids,
            created_at: now,
            updated_at: now,
          });
          notify(vaultDir, {
            domain: 'skills',
            type: 'skill.surveyed',
            title: `Skill candidate: ${args.topic}`,
            message: args.rationale.slice(0, 120),
            link: '/skills?tab=candidates',
            metadata: { candidateId: candidate.id, topic: args.topic },
          });
          return textResult(candidate);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          const now = epochSeconds();
          const updated = updateCandidate(args.id, {
            ...(args.topic !== undefined ? { topic: args.topic } : {}),
            ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
            ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            ...(args.skill_id !== undefined ? { skill_id: args.skill_id } : {}),
            updated_at: now,
          });
          if (!updated) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const deleted = deleteCandidate(args.id);
          if (!deleted) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult({ deleted: true, id: args.id });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultSkillRecords = tool(
    'vault_skill_records',
    'Read, update, and delete skill records (materialized skills on disk). Supports list, get, update, and delete actions.',
    {
      action: z.enum(['list', 'get', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Skill record ID or name (required for get/update/delete)'),
      status: z.enum(['active', 'stale', 'retired']).optional().describe('Filter by status'),
      generation: z.number().optional().describe('New generation number (for update)'),
      source_ids: z.string().optional().describe('JSON array of source IDs (for update)'),
      description: z.string().optional().describe('Updated description (for update)'),
      limit: z.number().optional().describe('Maximum records to return (for list)'),
    },
    async (args) => {
      recordTurn('vault_skill_records', args);

      switch (args.action) {
        case 'list': {
          const records = listSkillRecords({
            agent_id: agentId,
            status: args.status,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(records);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const record = getSkillRecord(args.id) ?? getSkillRecordByName(args.id);
          if (!record) return textResult({ error: `Skill record not found: ${args.id}` });
          return textResult(record);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          // Resolve by id or name
          const existing = getSkillRecord(args.id) ?? getSkillRecordByName(args.id);
          if (!existing) return textResult({ error: `Skill record not found: ${args.id}` });

          const now = epochSeconds();
          const updated = updateSkillRecord(existing.id, {
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.generation !== undefined ? { generation: args.generation } : {}),
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            updated_at: now,
          });
          if (!updated) return textResult({ error: `Failed to update skill record: ${existing.id}` });
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const result = deleteSkillRecordCascade(args.id);
          if (!result) return textResult({ error: `Skill record not found: ${args.id}` });
          // Disk + symlink cleanup (best-effort)
          const root = projectRoot ?? process.cwd();
          if (!/[/\\]|\.\./.test(result.name)) {
            const skillDir = resolve(root, '.agents', 'skills', result.name);
            try { rmSync(skillDir, { recursive: true, force: true }); } catch (err) {
              console.warn('[vault_skill_records] Failed to remove skill directory:', err instanceof Error ? err.message : err);
            }
            try {
              const { syncSkillSymlinks } = await import('../../symbionts/installer.js');
              syncSkillSymlinks(root, result.name, { remove: true });
            } catch (err) {
              console.warn('[vault_skill_records] Failed to remove symlinks:', err instanceof Error ? err.message : err);
            }
          }
          return textResult({ deleted: true, id: result.id, name: result.name });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultWriteSkill = tool(
    'vault_write_skill',
    'Write a SKILL.md file to disk and create or update the corresponding skill record and lineage entry.',
    {
      name: z.string().describe('Skill directory name (kebab-case, NO colon). The myco: prefix goes in the SKILL.md frontmatter name field, not here.'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().describe('Short description of what the skill does'),
      content: z.string().describe('Full SKILL.md content in markdown'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      candidate_id: z.string().optional().describe('Candidate ID that prompted this skill creation'),
      rationale: z.string().optional().describe('Why this skill was created or updated'),
    },
    async (args) => {
      // Validate skill content before writing -- reject malformed skills
      const validationErrors = validateSkillContent(args.content, args.name);
      if (validationErrors.length > 0) {
        recordTurn('vault_write_skill', args);
        return textResult({
          error: 'Skill validation failed. Fix these issues and try again.',
          issues: validationErrors,
        });
      }

      // Path traversal guard -- reject names containing path separators or dot-dot sequences
      if (!args.name || /[/\\]|\.\./.test(args.name)) {
        recordTurn('vault_write_skill', args);
        return textResult({
          error: 'Invalid skill name: must be a simple directory name without path separators or ".."',
        });
      }

      const root = projectRoot ?? process.cwd();
      const skillDir = resolve(root, '.agents', 'skills', args.name);
      const skillPath = resolve(skillDir, 'SKILL.md');

      // Frontmatter preservation guard — when updating an existing skill,
      // reject writes that change protected fields (user-invocable, allowed-tools).
      // These fields are set by the skill author, not the evolve pipeline.
      if (existsSync(skillPath)) {
        const existingContent = readFileSync(skillPath, 'utf-8');
        const violations = checkFrontmatterPreservation(existingContent, args.content);
        if (violations.length > 0) {
          recordTurn('vault_write_skill', args);
          return textResult({
            error: 'Skill update rejected: protected frontmatter fields were changed. Read the existing skill and preserve these values exactly.',
            violations,
          });
        }
      }

      // Write file to disk -- must succeed before any DB operations
      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillPath, args.content, 'utf-8');
      } catch (err) {
        return textResult({ error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Create agent-specific symlinks so each symbiont discovers the skill.
      // Uses the shared syncSkillSymlinks which reads manifest skillsTarget paths.
      try {
        const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
        syncSkillSymlinks(root, args.name);
      } catch (err) {
        // Best-effort -- skill file is written, symlinks are convenience
        console.warn('[vault_write_skill] syncSkillSymlinks failed:', err instanceof Error ? err.message : err);
      }

      const now = epochSeconds();
      const relativePath = `.agents/skills/${args.name}/SKILL.md`;

      // Check for existing record
      const existing = getSkillRecordByName(args.name);

      let recordId = '';
      let generation = 0;

      // All DB mutations wrapped in a transaction for atomicity.
      // File write (above) is the source of truth; DB is derived.
      const txDb = getDatabase();
      txDb.transaction(() => {
        if (existing) {
          // Update existing record -- bump generation
          generation = existing.generation + 1;
          recordId = existing.id;
          updateSkillRecord(existing.id, {
            display_name: args.display_name,
            description: args.description,
            generation,
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            path: relativePath,
            updated_at: now,
          });

          // Record lineage
          insertLineage({
            id: crypto.randomUUID(),
            skill_id: existing.id,
            generation,
            action: 'updated',
            rationale: args.rationale ?? 'Skill content updated',
            source_ids_added: args.source_ids,
            content_snapshot: args.content,
            created_at: now,
          });
        } else {
          // Create new record
          recordId = crypto.randomUUID();
          generation = 1;
          insertSkillRecord({
            id: recordId,
            agent_id: agentId,
            machine_id: machineId,
            name: args.name,
            display_name: args.display_name,
            description: args.description,
            candidate_id: args.candidate_id ?? null,
            source_ids: args.source_ids,
            path: relativePath,
            created_at: now,
            updated_at: now,
          });

          // Record lineage
          insertLineage({
            id: crypto.randomUUID(),
            skill_id: recordId,
            generation,
            action: 'created',
            rationale: args.rationale ?? 'Initial skill creation',
            source_ids_added: args.source_ids,
            content_snapshot: args.content,
            created_at: now,
          });

          // Auto-link candidate: find the approved candidate this skill was generated from.
          // Strategy: exact candidate_id -> prefix match.
          // Does NOT depend on the agent passing the correct ID.
          const approvedCandidates = listCandidates({ status: 'approved', limit: 10 });
          let linkedCandidate = false;

          // 1. Try exact candidate_id if provided
          if (args.candidate_id && !linkedCandidate) {
            const exact = updateCandidate(args.candidate_id, {
              status: 'generated', skill_id: recordId, updated_at: now,
            });
            if (exact) linkedCandidate = true;
          }

          // 2. Try prefix match on candidate_id (agent truncates UUIDs)
          if (args.candidate_id && !linkedCandidate) {
            const prefixMatch = approvedCandidates.find((c) => c.id.startsWith(args.candidate_id!));
            if (prefixMatch) {
              updateCandidate(prefixMatch.id, {
                status: 'generated', skill_id: recordId, updated_at: now,
              });
              linkedCandidate = true;
            }
          }

          // No blind fallback -- if neither exact nor prefix match found the candidate,
          // skip linking. The candidate stays 'approved' for the next generate cycle.
          // The daemon injection (Layer 2) ensures candidate_id is always provided in
          // scheduled runs, making this fallback-skip path rare.
        }
      })();

      const isNew = generation === 1;
      notify(vaultDir, {
        domain: 'skills',
        type: isNew ? 'skill.created' : 'skill.evolved',
        title: isNew ? `Skill created: ${args.display_name}` : `Skill evolved: ${args.display_name}`,
        message: args.description.slice(0, 120),
        link: `/skills?skill=${encodeURIComponent(args.name)}`,
        metadata: { skillId: recordId, name: args.name, generation },
      });

      recordTurn('vault_write_skill', args);
      return textResult({
        id: recordId,
        name: args.name,
        path: relativePath,
        generation,
      });
    },
    { annotations: { openWorldHint: true } },
  );

  return [
    vaultSkillCandidates,
    vaultSkillRecords,
    vaultWriteSkill,
  ];
}
