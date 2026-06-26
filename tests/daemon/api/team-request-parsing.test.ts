/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from 'bun:test';

import { parseOptionalTeamId } from '@myco/daemon/api/team-request-parsing.js';

describe('parseOptionalTeamId', () => {
  it('preserves absent team_id for legacy unscoped callers', () => {
    expect(parseOptionalTeamId(undefined)).toEqual({ ok: true, teamId: undefined });
    expect(parseOptionalTeamId({})).toEqual({ ok: true, teamId: undefined });
  });

  it('returns a trimmed team_id when present', () => {
    expect(parseOptionalTeamId({ team_id: '  team_abc  ' })).toEqual({ ok: true, teamId: 'team_abc' });
  });

  it('rejects blank or non-string team_id instead of broadening scope', () => {
    expect(parseOptionalTeamId({ team_id: '' })).toEqual({ ok: false, error: 'invalid_team_id' });
    expect(parseOptionalTeamId({ team_id: 123 })).toEqual({ ok: false, error: 'invalid_team_id' });
  });
});
