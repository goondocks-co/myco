import type { ServerEnv } from '../../core/adapters.js';

export interface OwnerConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

/** The shortest session secret accepted. A short HMAC key is brute-forceable offline from one captured cookie. */
export const MIN_SESSION_SECRET_LENGTH = 32;

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
};

/** The deploy-time sign-in configuration, or null when it is incomplete. Who may enter is a membership question, answered per request. */
export function ownerConfig(env: ServerEnv): OwnerConfig | null {
  const clientId = present(env.secrets?.GITHUB_CLIENT_ID);
  const clientSecret = present(env.secrets?.GITHUB_CLIENT_SECRET);
  const sessionSecret = present(env.secrets?.SESSION_SECRET);
  if (clientId === null || clientSecret === null || sessionSecret === null) return null;
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) return null;
  return { clientId, clientSecret, sessionSecret };
}
