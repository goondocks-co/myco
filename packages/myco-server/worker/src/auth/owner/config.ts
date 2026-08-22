import type { Env } from '../../env.js';

export interface OwnerConfig {
  ownerGithubId: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

/** A GitHub account id: digits only. */
const ACCOUNT_ID = /^[0-9]+$/;

/** The shortest session secret accepted. A short HMAC key is brute-forceable offline from one captured cookie. */
export const MIN_SESSION_SECRET_LENGTH = 32;

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
};

/** The deploy-time owner configuration, or null when it is incomplete. */
export function ownerConfig(env: Env): OwnerConfig | null {
  const ownerGithubId = present(env.OWNER_GITHUB_ID);
  const clientId = present(env.GITHUB_CLIENT_ID);
  const clientSecret = present(env.GITHUB_CLIENT_SECRET);
  const sessionSecret = present(env.SESSION_SECRET);
  if (ownerGithubId === null || clientId === null || clientSecret === null || sessionSecret === null) return null;
  if (!ACCOUNT_ID.test(ownerGithubId)) return null;
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) return null;
  return { ownerGithubId, clientId, clientSecret, sessionSecret };
}
