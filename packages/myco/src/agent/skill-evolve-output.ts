/**
 * Copyright 2026 Christopher Lovell
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const SKILL_EVOLVE_TASK_NAME = 'skill-evolve';
export const SKILL_EVOLVE_INVENTORY_STATE_KEY = 'skill-evolve-inventory';
export const SKILL_EVOLVE_CLASSIFICATIONS_STATE_KEY = 'skill-evolve-classifications';
export const SKILL_EVOLVE_INVENTORY_REPORT_ACTION = 'skill-evolve-inventory';
export const SKILL_EVOLVE_ASSESS_REPORT_ACTION = 'assess';

const CLASSIFICATION_VALUES = new Set([
  'CURRENT',
  'STALE',
  'DEPRECATED',
  'MERGE',
  'NARROW',
] as const);

export interface SkillEvolveClassification {
  skill_id: string;
  name: string;
  classification: 'CURRENT' | 'STALE' | 'DEPRECATED' | 'MERGE' | 'NARROW';
  target_skill: string | null;
  details: string;
}

export interface SkillEvolveClassificationPayload {
  run_id: string;
  classifications: SkillEvolveClassification[];
  deferred_skills: string[];
}

export interface SkillEvolveInventoryPayload {
  run_id: string;
  merge_candidates: Array<{
    source: string;
    target: string;
    reason: string;
  }>;
  narrow_candidates: Array<{
    skill: string;
    absorb_into: string;
    reason: string;
  }>;
}

export interface VaultSetStateIntentLike {
  tool_name: string;
  tool_input: unknown;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length === value.length ? strings : null;
}

function normalizeClassification(value: unknown): SkillEvolveClassification | null {
  const record = asRecord(value);
  if (!record) return null;

  const skillId = asString(record.skill_id);
  const name = asString(record.name);
  const classification = asString(record.classification);
  if (!skillId || !name || !classification || !CLASSIFICATION_VALUES.has(classification as SkillEvolveClassification['classification'])) {
    return null;
  }

  const target = record.target_skill === null || record.target_skill === undefined
    ? null
    : asOptionalString(record.target_skill);
  if (target === null && record.target_skill !== null && record.target_skill !== undefined) {
    return null;
  }

  return {
    skill_id: skillId,
    name,
    classification: classification as SkillEvolveClassification['classification'],
    target_skill: target,
    details: asOptionalString(record.details) ?? '',
  };
}

function normalizeClassificationPayload(value: unknown): SkillEvolveClassificationPayload | null {
  const record = asRecord(value);
  if (!record) return null;

  const runId = asString(record.run_id);
  if (!runId || !Array.isArray(record.classifications)) return null;

  const classifications = record.classifications.map(normalizeClassification);
  if (classifications.some((item) => item === null)) return null;

  const deferredSkills = asStringArray(record.deferred_skills);
  if (!deferredSkills) return null;

  return {
    run_id: runId,
    classifications: classifications as SkillEvolveClassification[],
    deferred_skills: deferredSkills,
  };
}

function normalizeMergeCandidate(value: unknown): SkillEvolveInventoryPayload['merge_candidates'][number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const source = asString(record.source);
  const target = asString(record.target);
  if (!source || !target) return null;
  return {
    source,
    target,
    reason: asOptionalString(record.reason) ?? '',
  };
}

function normalizeNarrowCandidate(value: unknown): SkillEvolveInventoryPayload['narrow_candidates'][number] | null {
  const record = asRecord(value);
  if (!record) return null;
  const skill = asString(record.skill);
  const absorbInto = asString(record.absorb_into);
  if (!skill || !absorbInto) return null;
  return {
    skill,
    absorb_into: absorbInto,
    reason: asOptionalString(record.reason) ?? '',
  };
}

export function parseSkillEvolveInventoryPayload(value: unknown): SkillEvolveInventoryPayload | null {
  const record = asRecord(value);
  if (!record) return null;

  const runId = asString(record.run_id);
  if (!runId || !Array.isArray(record.merge_candidates) || !Array.isArray(record.narrow_candidates)) {
    return null;
  }

  const mergeCandidates = record.merge_candidates.map(normalizeMergeCandidate);
  const narrowCandidates = record.narrow_candidates.map(normalizeNarrowCandidate);
  if (mergeCandidates.some((item) => item === null) || narrowCandidates.some((item) => item === null)) {
    return null;
  }

  return {
    run_id: runId,
    merge_candidates: mergeCandidates as SkillEvolveInventoryPayload['merge_candidates'],
    narrow_candidates: narrowCandidates as SkillEvolveInventoryPayload['narrow_candidates'],
  };
}

export function parseSkillEvolveClassificationPayload(value: unknown): SkillEvolveClassificationPayload | null {
  return normalizeClassificationPayload(value);
}

type ComparableClassification = Pick<
  SkillEvolveClassification,
  'skill_id' | 'name' | 'classification' | 'target_skill'
>;

function comparableClassificationPayload(payload: SkillEvolveClassificationPayload): ComparableClassification[] {
  return [...payload.classifications].map((classification) => ({
    skill_id: classification.skill_id,
    name: classification.name,
    classification: classification.classification,
    target_skill: classification.target_skill,
  })).sort((left, right) => {
    const skillCompare = left.skill_id.localeCompare(right.skill_id);
    if (skillCompare !== 0) return skillCompare;
    return left.classification.localeCompare(right.classification);
  });
}

export function skillEvolveClassificationPayloadsEqual(
  left: SkillEvolveClassificationPayload,
  right: SkillEvolveClassificationPayload,
): boolean {
  return JSON.stringify(comparableClassificationPayload(left)) === JSON.stringify(comparableClassificationPayload(right));
}

export function findLatestVaultSetStateValue(
  intents: VaultSetStateIntentLike[],
  key: string,
): unknown {
  for (let index = intents.length - 1; index >= 0; index -= 1) {
    const intent = intents[index];
    if (intent.tool_name !== 'vault_set_state') continue;
    const input = asRecord(intent.tool_input);
    if (!input || input.key !== key) continue;
    return input.value;
  }
  return undefined;
}
