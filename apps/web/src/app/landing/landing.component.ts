import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { CollabService } from '../collab/collab.service';
import { readDiagramFile, takePickedFile } from '../core/diagram-import';
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
  private readonly collab = inject(CollabService);

  protected readonly importErrors = signal<readonly string[]>([]);

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

  /**
   * Open an exported diagram in a room of its own.
   *
   * Always a new room, never an existing one: importing into a shared room
   * would drop a whole diagram on top of whatever collaborators are editing.
   */
  protected async openFile(event: Event): Promise<void> {
    const file = takePickedFile(event);
    if (!file) return;

    const result = await readDiagramFile(file);
    if (!result.ok) {
      this.importErrors.set(result.errors);
      return;
    }
    const roomId = newRoomId();
    this.collab.queueImport(roomId, result.graph, result.intent);
    void this.router.navigate(['/', roomId]);
  }
}
