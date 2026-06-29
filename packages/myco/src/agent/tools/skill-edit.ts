// packages/myco/src/agent/tools/skill-edit.ts
export interface SkillEdit { old_string: string; new_string: string; replace_all?: boolean }
export type ApplyEditsResult = { ok: true; content: string } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0, idx = haystack.indexOf(needle);
  while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
  return count;
}

export function applySkillEdits(content: string, edits: SkillEdit[]): ApplyEditsResult {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: 'No edits provided.' };
  let working = content;
  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string, replace_all } = edits[i];
    const label = `edit ${i + 1}`;
    if (typeof old_string !== 'string' || old_string.length === 0) {
      return { ok: false, error: `${label}: old_string must be a non-empty string.` };
    }
    const occurrences = countOccurrences(working, old_string);
    if (occurrences === 0) return { ok: false, error: `${label}: old_string not found in current skill content.` };
    if (occurrences > 1 && !replace_all) {
      return { ok: false, error: `${label}: old_string matches ${occurrences} times — add surrounding context to make it unique, or set replace_all.` };
    }
    // Literal replacement (a function replacer is NOT treated as a $-pattern).
    working = replace_all
      ? working.split(old_string).join(new_string)
      : working.replace(old_string, () => new_string);
  }
  return { ok: true, content: working };
}
