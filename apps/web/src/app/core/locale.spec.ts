import { describe, expect, it } from 'vitest';
import { pickLocale } from './locale';

describe('pickLocale', () => {
  it('follows the browser when nothing was chosen', () => {
    expect(pickLocale(null, ['de-DE', 'en-US'])).toBe('de');
    expect(pickLocale(null, ['de-AT'])).toBe('de');
    expect(pickLocale(null, ['en-GB', 'de-DE'])).toBe('en');
  });

  it('skips languages it has no translation for', () => {
    expect(pickLocale(null, ['fr-FR', 'de-CH'])).toBe('de');
  });

  it('falls back to English', () => {
    expect(pickLocale(null, ['fr-FR'])).toBe('en');
    expect(pickLocale(null, [])).toBe('en');
  });

  it('lets an explicit choice win over the browser', () => {
    expect(pickLocale('en', ['de-DE'])).toBe('en');
    expect(pickLocale('de', ['en-US'])).toBe('de');
  });

  it('ignores a stored value it does not recognise', () => {
    expect(pickLocale('fr', ['de-DE'])).toBe('de');
  });
});
