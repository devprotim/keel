import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGithubUser, fetchGoogleUser } from './providers.ts';

function fakeFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
}

describe('fetchGithubUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes a GitHub profile, preferring the display name over the login', async () => {
    vi.stubGlobal('fetch', fakeFetch({ id: 42, login: 'ada', name: 'Ada Lovelace', avatar_url: 'https://gh.example/a.png' }));

    const user = await fetchGithubUser('token');

    expect(user).toEqual({ id: 'github:42', provider: 'github', name: 'Ada Lovelace', avatarUrl: 'https://gh.example/a.png' });
  });

  it('falls back to the login when no display name is set', async () => {
    vi.stubGlobal('fetch', fakeFetch({ id: 42, login: 'ada', name: null, avatar_url: null }));

    const user = await fetchGithubUser('token');

    expect(user).toEqual({ id: 'github:42', provider: 'github', name: 'ada', avatarUrl: null });
  });

  it('throws when the provider rejects the token', async () => {
    vi.stubGlobal('fetch', fakeFetch({}, false, 401));

    await expect(fetchGithubUser('bad-token')).rejects.toThrow('401');
  });
});

describe('fetchGoogleUser', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes a Google profile', async () => {
    vi.stubGlobal('fetch', fakeFetch({ sub: '123', name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://g.example/a.png' }));

    const user = await fetchGoogleUser('token');

    expect(user).toEqual({ id: 'google:123', provider: 'google', name: 'Ada Lovelace', avatarUrl: 'https://g.example/a.png' });
  });

  it('falls back to the email when no name is set', async () => {
    vi.stubGlobal('fetch', fakeFetch({ sub: '123', name: null, email: 'ada@example.com', picture: null }));

    const user = await fetchGoogleUser('token');

    expect(user.name).toBe('ada@example.com');
  });
});
