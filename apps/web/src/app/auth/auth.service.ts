import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { KEEL_CONFIG } from '../core/app-config';

export interface AuthUser {
  id: string;
  provider: 'github' | 'google';
  name: string;
  avatarUrl: string | null;
}

/**
 * Identity is additive, not access control: every room stays open to anyone
 * with the link whether or not this reports a user. Signing in only replaces
 * the client's random guest name/avatar with the provider's real one.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly #config = inject(KEEL_CONFIG);
  readonly #http = inject(HttpClient);

  readonly #user = signal<AuthUser | null>(null);
  readonly user = this.#user.asReadonly();

  /** Ask the server who, if anyone, this browser is signed in as. */
  async refresh(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.#http.get<{ user: AuthUser | null }>(`${this.#config.apiUrl}/api/auth/me`, { withCredentials: true }),
      );
      this.#user.set(response.user);
    } catch {
      this.#user.set(null);
    }
  }

  /** Full-page redirect into the provider's login flow; there is no in-app step. */
  loginWithGithub(returnTo: string): void {
    this.#redirectToLogin('github', returnTo);
  }

  loginWithGoogle(returnTo: string): void {
    this.#redirectToLogin('google', returnTo);
  }

  async logout(): Promise<void> {
    await firstValueFrom(
      this.#http.post(`${this.#config.apiUrl}/api/auth/logout`, null, { withCredentials: true }),
    );
    this.#user.set(null);
  }

  #redirectToLogin(provider: 'github' | 'google', returnTo: string): void {
    const url = new URL(`${this.#config.apiUrl}/api/auth/${provider}`);
    url.searchParams.set('returnTo', returnTo);
    globalThis.location.href = url.toString();
  }
}
