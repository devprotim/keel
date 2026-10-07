import { describe, expect, it } from 'vitest';
import { sizedAvatarUrl } from './avatar';

describe('sizedAvatarUrl', () => {
  it('adds a size to a GitHub avatar, keeping its other parameters', () => {
    expect(sizedAvatarUrl('https://avatars.githubusercontent.com/u/1?v=4', 44)).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4&s=44',
    );
  });

  it('replaces a size that is already there', () => {
    expect(sizedAvatarUrl('https://avatars.githubusercontent.com/u/1?v=4&s=460', 44)).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4&s=44',
    );
  });

  it('leaves other hosts and unparseable values alone', () => {
    const google = 'https://lh3.googleusercontent.com/a/abc=s96-c';
    expect(sizedAvatarUrl(google, 44)).toBe(google);
    expect(sizedAvatarUrl('not a url', 44)).toBe('not a url');
  });
});
