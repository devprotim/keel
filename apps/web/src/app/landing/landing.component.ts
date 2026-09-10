import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { newRoomId } from '../core/room-id';

/**
 * The front door. Shown at `/` instead of minting a room immediately, so a
 * first-time visitor sees what Keel is and gets a chance to sign in before a
 * diagram exists under them.
 */
@Component({
  selector: 'keel-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.scss',
})
export class LandingComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  constructor() {
    void this.auth.refresh();
  }

  protected loginWithGithub(): void {
    this.auth.loginWithGithub(`/${newRoomId()}`);
  }

  protected loginWithGoogle(): void {
    this.auth.loginWithGoogle(`/${newRoomId()}`);
  }

  /**
   * Guest-first: drop straight into a new room regardless of auth state.
   * Auth never gates a room elsewhere in the app, so the landing CTA
   * shouldn't be the one place that asks for identity first.
   */
  protected startDiagram(): void {
    void this.router.navigate(['/', newRoomId()]);
  }
}
