/**
 * Skill usage detection for session reconciliation.
 *
 * Scans session transcript content for Myco-managed skill activations and
 * records them in the skill_usage table. Idempotent — skips skills already
 * recorded for this session.
 */

import { listSkillRecords, incrementSkillUsageCount } from '@myco/db/queries/skill-records.js';
import { insertSkillUsage, hasUsageForSkillAndSession } from '@myco/db/queries/skill-usage.js';
import { epochSeconds } from '@myco/constants.js';
import crypto from 'node:crypto';

/** Set to true to enable automatic skill usage detection from transcripts. */
export const SKILL_USAGE_DETECTION_ENABLED = false;

/** Maximum number of active skills to check in a single detection pass. */
const MAX_ACTIVE_SKILLS_CHECK = 1000;

/**
 * Scan a session transcript for Myco-managed skill activations.
 * Idempotent — skips skills already recorded for this session.
 */
export function detectSkillUsage(sessionId: string, transcriptContent: string): void {
  // Skip transcripts that contain vault_write_skill calls — these are
  // agent sessions generating/evolving skills, not developer sessions using them.
  if (transcriptContent.includes('vault_write_skill')) return;

  // Automatic detection is gated: the regex-based approach produces false
  // positives when a skill name is merely *discussed* in a session (not actually
  // loaded). Re-enable once a reliable activation signal is available (e.g., a
  // specific tag that Claude Code emits when loading a skill file).
  if (!SKILL_USAGE_DETECTION_ENABLED) return;

  const activeSkills = listSkillRecords({ status: 'active', limit: MAX_ACTIVE_SKILLS_CHECK });
  if (activeSkills.length === 0) return;

  // Pre-compile patterns for all skills outside the loop
  const skillPatterns = activeSkills.map((skill) => ({
    skill,
    pattern: new RegExp(
      `skills/${escapeRegex(skill.name)}/SKILL\\.md|` +
      `<skill[^>]*name=["']${escapeRegex(skill.name)}["']`,
    ),
  }));

  const now = epochSeconds();

  for (const { skill, pattern } of skillPatterns) {
    try {
      if (!pattern.test(transcriptContent)) continue;

      // Idempotent: skip if already recorded for this session
      if (hasUsageForSkillAndSession(skill.id, sessionId)) continue;

      // Record usage
      insertSkillUsage({
        id: crypto.randomUUID(),
        skill_id: skill.id,
        session_id: sessionId,
        detected_at: now,
      });

      // Atomically increment usage_count
      incrementSkillUsageCount(skill.id, now);
    } catch {
      // Best-effort per skill — don't let one broken skill stop detection
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
