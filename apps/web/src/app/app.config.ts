import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { KEEL_CONFIG, defaultConfig } from './core/app-config';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless is the default in Angular 22, so there is no zone provider here.
    // The whole app is signal-driven; nothing relies on zone.js patching.
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    { provide: KEEL_CONFIG, useFactory: defaultConfig },
  ],
};
