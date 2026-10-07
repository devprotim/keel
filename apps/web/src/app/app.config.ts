import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, isDevMode } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';
import { KEEL_CONFIG, defaultConfig } from './core/app-config';
import { credentialsInterceptor } from './core/credentials.interceptor';
import { provideRouteFocus } from './core/route-focus';
import { onViewTransitionCreated } from './core/view-transitions';
import { routes } from './app.routes';
import { provideServiceWorker } from '@angular/service-worker';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Zoneless is the default in Angular 22, so there is no zone provider here.
    // The whole app is signal-driven; nothing relies on zone.js patching.
    // Route changes cross-fade through the View Transitions API; browsers
    // without it navigate instantly. Not on first load, which has nothing to
    // fade from. Skip rules: core/view-transitions.ts.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions({ skipInitialTransition: true, onViewTransitionCreated }),
    ),
    provideRouteFocus(),
    provideHttpClient(withFetch(), withInterceptors([credentialsInterceptor])),
    { provide: KEEL_CONFIG, useFactory: defaultConfig },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
