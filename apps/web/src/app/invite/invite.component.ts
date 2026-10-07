import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AccessService, describeError, type Role } from '../access/access.service';
import { AuthService } from '../auth/auth.service';

/**
 * `/invite/:token`: joining a workspace from a link an owner shared.
 *
 * Signing in comes first, since membership belongs to a person, and the
 * sign-in round trip lands back here. Accepting leads to the landing page,
 * which lists the workspace's diagrams.
 */
@Component({
  selector: 'keel-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invite.component.html',
  styleUrl: './invite.component.scss',
})
export class InviteComponent {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(AccessService);
  private readonly router = inject(Router);

  /** Bound from the route by withComponentInputBinding. */
  readonly token = input.required<string>();

  readonly invite = signal<{ workspace: { name: string }; role: Role } | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  constructor() {
    void this.auth.refresh();
    queueMicrotask(() => void this.load());
  }

  async load(): Promise<void> {
    try {
      this.invite.set(await this.api.invite(this.token()));
    } catch (error) {
      this.error.set(describeError(error, $localize`:Error when an invite link is invalid or expired:This invite link does not work.`));
    }
  }

  signIn(): void {
    this.auth.loginWithGithub(`/invite/${this.token()}`);
  }

  async accept(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.acceptInvite(this.token());
      void this.router.navigate(['/']);
    } catch (error) {
      this.error.set(describeError(error, $localize`:Error when accepting a workspace invite fails:Could not join.`));
    } finally {
      this.busy.set(false);
    }
  }
}
