import { LOCALE_ID } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { ANGULAR_LOCALE_ID, type Locale } from './app/core/locale';

/** Imported by main.ts only after the locale's translations are loaded. */
export function bootstrap(locale: Locale) {
  return bootstrapApplication(App, {
    ...appConfig,
    providers: [...appConfig.providers, { provide: LOCALE_ID, useValue: ANGULAR_LOCALE_ID[locale] }],
  });
}
