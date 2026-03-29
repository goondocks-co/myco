/**
 * Skill usage detection for session reconciliation.
 *
 * Scans session transcript content for Myco-managed skill activations and
 * records them in the skill_usage table. Idempotent — skips skills already
 * recorded for this session.
 */

import { listSkillRecords, updateSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertSkillUsage, listUsageForSkill } from '@myco/db/queries/skill-usage.js';
import { epochSeconds } from '@myco/constants.js';
import crypto from 'node:crypto';

/**
 * Scan a session transcript for Myco-managed skill activations.
 * Idempotent — skips skills already recorded for this session.
 */
export function detectSkillUsage(sessionId: string, transcriptContent: string): void {
  const activeSkills = listSkillRecords({ status: 'active' });
  if (activeSkills.length === 0) return;

  const now = epochSeconds();

  for (const skill of activeSkills) {
    // Check if skill name appears in transcript.
    // Skills show up as: skills/<name>/SKILL.md or <skill name="<name>">
    const namePattern = new RegExp(
      `skills/${escapeRegex(skill.name)}/SKILL\\.md|` +
      `<skill[^>]*name=["']${escapeRegex(skill.name)}["']`,
    );

    if (!namePattern.test(transcriptContent)) continue;

    // Idempotent: skip if already recorded for this session
    const existing = listUsageForSkill(skill.id).find(
      (u) => u.session_id === sessionId,
    );
    if (existing) continue;

    // Record usage
    insertSkillUsage({
      id: crypto.randomUUID(),
      skill_id: skill.id,
      session_id: sessionId,
      detected_at: now,
    });

    // Increment usage_count
    updateSkillRecord(skill.id, {
      usage_count: skill.usage_count + 1,
      last_used_at: now,
      updated_at: now,
    });
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
