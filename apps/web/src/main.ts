import { registerLocaleData } from '@angular/common';
import { loadTranslations } from '@angular/localize';
import { chosenLocale, type Locale } from './app/core/locale';

/**
 * `$localize` itself is installed by the `polyfills` entry in angular.json.
 * Translations load before the app's own modules do: `$localize` strings at
 * module level (the landing page's pitches, for one) are resolved on import,
 * so the app is imported only once they are in place. A missing or broken
 * translation file falls back to English rather than leaving a blank page.
 */
async function start(): Promise<void> {
  let locale: Locale = chosenLocale();
  if (locale === 'de') {
    try {
      const [file, data] = await Promise.all([
        fetch('/i18n/de.json').then((response) => {
          if (!response.ok) throw new Error(`translations: HTTP ${response.status}`);
          return response.json() as Promise<{ translations: Record<string, string> }>;
        }),
        import('@angular/common/locales/de'),
      ]);
      loadTranslations(file.translations);
      registerLocaleData(data.default);
    } catch (error) {
      console.error('Could not load German translations; continuing in English.', error);
      locale = 'en';
    }
  }
  document.documentElement.lang = locale;

  const { bootstrap } = await import('./bootstrap');
  await bootstrap(locale);
}

start().catch((err) => console.error(err));
