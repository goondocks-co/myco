/**
 * Bearer token auth for the Myco team sync worker.
 */

export interface AuthEnv {
  MYCO_TEAM_API_KEY: string;
}

/**
 * Validate the Authorization header against the configured API key.
 * Returns null on success, or a 401 Response on failure.
 */
export function validateAuth(request: Request, env: AuthEnv): Response | null {
  const header = request.headers.get('Authorization');
  if (!header) {
    return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token !== env.MYCO_TEAM_API_KEY) {
    return new Response(JSON.stringify({ error: 'Invalid API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
