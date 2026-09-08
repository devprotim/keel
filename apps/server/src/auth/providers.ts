import type { SessionUser } from './session.ts';

/**
 * Turn a provider access token into the identity we actually store: a stable
 * id, a display name, and an avatar. Nothing else about the account is read,
 * since login here exists only to replace the random guest name in presence.
 */
export async function fetchGithubUser(accessToken: string): Promise<SessionUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      // GitHub's API rejects unauthenticated-looking requests without one.
      'User-Agent': 'keel-app',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }

  const profile = (await response.json()) as { id: number; name?: string | null; login: string; avatar_url?: string | null };
  return {
    id: `github:${profile.id}`,
    provider: 'github',
    name: profile.name?.trim() || profile.login,
    avatarUrl: profile.avatar_url ?? null,
  };
}

export async function fetchGoogleUser(accessToken: string): Promise<SessionUser> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Google user lookup failed: ${response.status}`);
  }

  const profile = (await response.json()) as { sub: string; name?: string | null; email?: string | null; picture?: string | null };
  return {
    id: `google:${profile.sub}`,
    provider: 'google',
    name: profile.name?.trim() || profile.email || 'Google user',
    avatarUrl: profile.picture ?? null,
  };
}
