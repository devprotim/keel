import { InjectionToken } from '@angular/core';

export interface KeelConfig {
  /** Base URL of the collaboration server's HTTP API. */
  apiUrl: string;
  /** Base URL of the collaboration WebSocket, without the room path. */
  wsUrl: string;
}

/**
 * Injected rather than imported so tests and future deployments can swap it
 * without touching the services that read it.
 */
export const KEEL_CONFIG = new InjectionToken<KeelConfig>('KEEL_CONFIG');

/**
 * Defaults for local development.
 *
 * In a browser the API is assumed to be same-origin behind `/api` unless it is
 * being served from the Angular dev server, which runs on its own port and
 * therefore has to point at the backend explicitly.
 */
export function defaultConfig(): KeelConfig {
  const { protocol, hostname, port, origin } = globalThis.location ?? {
    protocol: 'http:',
    hostname: 'localhost',
    port: '4200',
    origin: 'http://localhost:4200',
  };

  const isDevServer = port === '4200';
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';

  return isDevServer
    ? { apiUrl: `${protocol}//${hostname}:8787`, wsUrl: `${wsProtocol}//${hostname}:8787` }
    : { apiUrl: origin, wsUrl: `${wsProtocol}//${hostname}${port ? `:${port}` : ''}` };
}
