import { describe, expect, it } from 'vitest';
import source from '../../locale/messages.json';
import german from '../../../public/i18n/de.json';

/**
 * src/locale/messages.json is what `ng extract-i18n` finds in the code; a
 * string added or reworded there has a new id. This keeps the German file in
 * step with it, so a missing translation is a failing test rather than an
 * English sentence in a German UI.
 */

const placeholders = (text: string) =>
  [...text.matchAll(/\{\$[A-Za-z0-9_]+\}|\{(?:VAR_PLURAL|VAR_SELECT|INTERPOLATION[_0-9]*)\b/g)].map((m) => m[0]).sort();

describe('German translations', () => {
  const de: Record<string, string> = german.translations;

  it('cover every extracted message', () => {
    const missing = Object.entries(source.translations as Record<string, string>)
      .filter(([id]) => !(id in de))
      .map(([id, text]) => `${id}: ${text}`);
    expect(missing).toEqual([]);
  });

  it('keep every placeholder', () => {
    const broken = Object.entries(source.translations as Record<string, string>)
      .filter(([id, text]) => id in de && placeholders(text).join() !== placeholders(de[id]).join())
      .map(([id]) => id);
    expect(broken).toEqual([]);
  });

  it('hold nothing that is no longer in the code', () => {
    const stale = Object.keys(de).filter((id) => !(id in source.translations));
    expect(stale).toEqual([]);
  });
});
