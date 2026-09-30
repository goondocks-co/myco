import { postJson } from './api';

/** Ends the dashboard session and returns to the start, whatever the server answers. */
export async function signOut(): Promise<void> {
  try {
    await postJson('/auth/logout');
  } finally {
    window.location.assign('/');
  }
}
