import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AccessService, type WorkspaceDetail } from '../access/access.service';
import { AuthService } from '../auth/auth.service';
import { CollabService } from '../collab/collab.service';
import { demoRoom } from '../core/demo';
import { readDiagramFile, takePickedFile } from '../core/diagram-import';
import { newRoomId } from '../core/room-id';
import { FEATURES, pitchFor } from './pitches';

/**
 * The front door. Shown at `/` instead of minting a room immediately, so a
 * first-time visitor sees what Keel is and gets a chance to sign in before a
 * diagram exists under them.
 */
@Component({
  selector: 'keel-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.scss',
})
export class LandingComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly collab = inject(CollabService);

  private readonly access = inject(AccessService);

  /** `?pitch=<id>` previews another message on the real page; see pitches.ts. */
  private readonly pitchParam = toSignal(inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('pitch'))));
  protected readonly pitch = computed(() => pitchFor(this.pitchParam()));
  protected readonly features = FEATURES;

  protected readonly importErrors = signal<readonly string[]>([]);
  /** A signed-in visitor's workspaces, each with its diagrams. */
  protected readonly workspaces = signal<readonly WorkspaceDetail[]>([]);

  constructor() {
    void this.auth.refresh();
    effect(() => {
      if (this.auth.user()) untracked(() => void this.loadWorkspaces());
      else this.workspaces.set([]);
    });
  }

  private async loadWorkspaces(): Promise<void> {
    try {
      const summaries = await this.access.workspaces();
      this.workspaces.set(await Promise.all(summaries.map((w) => this.access.workspace(w.id))));
    } catch {
      // The list is a convenience; the landing page works without it.
    }
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
   * The worked example with production reporting in, in a room of its own.
   * See core/demo.ts for the story it tells.
   */
  protected openDemo(): void {
    const roomId = newRoomId();
    const demo = demoRoom();
    this.collab.queueImport(roomId, demo.graph, demo.intent, demo.observations);
    void this.router.navigate(['/', roomId]);
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
