import { describe, expect, it } from 'bun:test';
import {
  getSearchableSelectRank,
  type SearchableSelectOption,
} from '../../packages/myco/ui/src/components/ui/searchable-select';

const OPENAI_41_OPTION: SearchableSelectOption = {
  value: 'gpt-4.1-2025-04-14',
  label: 'gpt-4.1-2025-04-14',
};

const OPENAI_54_OPTION: SearchableSelectOption = {
  value: 'gpt-5.4-nano-2026-03-17',
  label: 'gpt-5.4-nano-2026-03-17',
};

describe('getSearchableSelectRank', () => {
  it('matches version-like queries only when the candidate contains that version', () => {
    expect(getSearchableSelectRank(OPENAI_54_OPTION, '5.4')).not.toBeNull();
    expect(getSearchableSelectRank(OPENAI_41_OPTION, '5.4')).toBeNull();
  });

  it('matches punctuation-insensitive compact queries for model ids', () => {
    expect(getSearchableSelectRank(OPENAI_54_OPTION, 'gpt54nano')).not.toBeNull();
  });

  it('supports multi-token textual matching without requiring exact punctuation', () => {
    expect(getSearchableSelectRank(
      { value: 'o3-mini-2025-01-31', label: 'o3-mini-2025-01-31' },
      'o3 mini',
    )).not.toBeNull();
  });
});
