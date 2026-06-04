import { describe, it, expect } from 'bun:test';
import { CAPABILITY_IDS } from '../../packages/myco/src/config/scope';

describe('capability ids', () => {
  it('declares the four capability ids', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(['canopy', 'cortex', 'skills', 'vault_evolution']);
  });
});
