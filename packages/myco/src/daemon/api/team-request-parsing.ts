/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export type OptionalTeamIdParseResult =
  | { ok: true; teamId: string | undefined }
  | { ok: false; error: 'invalid_team_id' };

export function parseOptionalTeamId(body: unknown): OptionalTeamIdParseResult {
  if (body == null || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'team_id')) {
    return { ok: true, teamId: undefined };
  }
  const value = (body as { team_id?: unknown }).team_id;
  if (typeof value !== 'string') return { ok: false, error: 'invalid_team_id' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'invalid_team_id' };
  return { ok: true, teamId: trimmed };
}
