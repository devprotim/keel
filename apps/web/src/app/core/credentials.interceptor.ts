import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KEEL_CONFIG } from './app-config';

/**
 * Send the session cookie with every call to Keel's own API.
 *
 * In production the API is same-origin and the browser sends it anyway. In
 * development the Angular server (:4200) and the API (:8787) are different
 * origins, and without this every workspace-gated call would look anonymous.
 */
export const credentialsInterceptor: HttpInterceptorFn = (request, next) => {
  const { apiUrl } = inject(KEEL_CONFIG);
  return next(request.url.startsWith(apiUrl) ? request.clone({ withCredentials: true }) : request);
};
