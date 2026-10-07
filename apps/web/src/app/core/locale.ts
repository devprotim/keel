/**
 * Which language the UI is in.
 *
 * Translation is Angular's own i18n (`i18n` attributes and `$localize`), loaded
 * at runtime rather than built once per language, so one build serves every
 * language and a room's link is the same whichever one the reader uses.
 * main.ts picks the locale before the app starts, because `$localize` strings
 * are resolved as their modules load; changing language is therefore a reload.
 */

export type Locale = 'en' | 'de';

/** Each language named in itself, the way a switcher should offer it. */
export const LOCALES: readonly { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
];

/** Angular's LOCALE_ID for each, which drives date and number formatting. */
export const ANGULAR_LOCALE_ID: Record<Locale, string> = { en: 'en-US', de: 'de' };

const STORAGE_KEY = 'keel:locale';

/** An explicit choice wins; otherwise the browser's first supported language; otherwise English. */
export function pickLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === 'en' || saved === 'de') return saved;
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'de') return 'de';
    if (base === 'en') return 'en';
  }
  return 'en';
}

export function chosenLocale(): Locale {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked; the browser language still applies.
  }
  return pickLocale(saved, typeof navigator === 'undefined' ? [] : navigator.languages);
}

/** The locale the running app was started in, from the `lang` main.ts set. */
export function activeLocale(): Locale {
  return typeof document !== 'undefined' && document.documentElement.lang === 'de' ? 'de' : 'en';
}

/** Remember the choice and restart in it. */
export function switchLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Without storage the switch lasts only until the browser language decides again.
  }
  location.reload();
}
