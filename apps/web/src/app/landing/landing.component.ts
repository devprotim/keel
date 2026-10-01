import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AccessService, describeError, type Billing, type PlanId, type WorkspaceDetail } from '../access/access.service';
import { AuthService } from '../auth/auth.service';
import { CollabService } from '../collab/collab.service';
import { demoRoom } from '../core/demo';
import { readDiagramFile, takePickedFile } from '../core/diagram-import';
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
  /** A new room is being made; the buttons that make one wait for it. */
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  /** A signed-in visitor's workspaces, each with its diagrams and plan. */
  protected readonly workspaces = signal<readonly (WorkspaceDetail & { billing: Billing | null })[]>([]);
  protected readonly billingError = signal<string | null>(null);
  /** Back from Stripe Checkout. The plan changes when Stripe's webhook lands, usually within seconds. */
  protected readonly billingReturn = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('billing'))),
  );

  constructor() {
    void this.auth.refresh();
    effect(() => {
      if (this.auth.user()) untracked(() => void this.loadWorkspaces());
      else this.workspaces.set([]);
    });

    // After Checkout, look again once Stripe has had a moment to confirm.
    effect((onCleanup) => {
      if (this.billingReturn() !== 'success' || !this.auth.user()) return;
      const timer = setTimeout(() => void this.loadWorkspaces(), 3000);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private async loadWorkspaces(): Promise<void> {
    try {
      const summaries = await this.access.workspaces();
      this.workspaces.set(
        await Promise.all(
          summaries.map(async (w) => ({
            ...(await this.access.workspace(w.id)),
            billing: await this.access.billing(w.id).catch(() => null),
          })),
        ),
      );
    } catch {
      // The list is a convenience; the landing page works without it.
    }
  }

  /** "2 of 3 editors · 1 of 3 diagrams", for a plan's limited dimensions. */
  protected usageLine(billing: Billing | null): string {
    if (!billing?.enabled) return '';
    const of = (used: number, limit: number | null, noun: string) => (limit === null ? `${used} ${noun}` : `${used} of ${limit} ${noun}`);
    return [
      of(billing.usage.editors, billing.plan.limits.editors, 'editors'),
      `${billing.usage.viewers} viewers`,
      of(billing.usage.rooms, billing.plan.limits.rooms, 'diagrams'),
    ].join(' · ');
  }

  protected async upgrade(workspaceId: string, plan: PlanId): Promise<void> {
    if (plan === 'free') return;
    this.billingError.set(null);
    try {
      location.assign((await this.access.checkout(workspaceId, plan)).url);
    } catch (error) {
      this.billingError.set(describeError(error, 'Could not open checkout.'));
    }
  }

  protected async manageBilling(workspaceId: string): Promise<void> {
    this.billingError.set(null);
    try {
      location.assign((await this.access.billingPortal(workspaceId)).url);
    } catch (error) {
      this.billingError.set(describeError(error, 'Could not open billing.'));
    }
  }

  /** Signing in lands in a new room, or back here if one can't be made. */
  protected async loginWithGithub(): Promise<void> {
    const roomId = await this.createRoom();
    this.auth.loginWithGithub(roomId ? `/${roomId}` : '/');
  }

  protected async loginWithGoogle(): Promise<void> {
    const roomId = await this.createRoom();
    this.auth.loginWithGoogle(roomId ? `/${roomId}` : '/');
  }

  /**
   * Guest-first: drop straight into a new room regardless of auth state.
   * Auth never gates a room elsewhere in the app, so the landing CTA
   * shouldn't be the one place that asks for identity first.
   */
  protected async startDiagram(): Promise<void> {
    const roomId = await this.createRoom();
    if (roomId) void this.router.navigate(['/', roomId]);
  }

  /**
   * The worked example with production reporting in, in a room of its own.
   * See core/demo.ts for the story it tells.
   */
  protected async openDemo(): Promise<void> {
    const roomId = await this.createRoom();
    if (!roomId) return;
    const demo = demoRoom();
    this.collab.queueImport(roomId, demo.graph, demo.intent, demo.observations);
    void this.router.navigate(['/', roomId]);
  }

  /**
   * The server picks room ids, so a new diagram needs it to be reachable.
   * Null, with the reason shown, when it isn't.
   */
  private async createRoom(): Promise<string | null> {
    this.createError.set(null);
    this.creating.set(true);
    try {
      return await this.access.createRoom();
    } catch (error) {
      this.createError.set(describeError(error, 'Could not create a diagram. Check your connection and try again.'));
      return null;
    } finally {
      this.creating.set(false);
    }
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
    const roomId = await this.createRoom();
    if (!roomId) return;
    this.collab.queueImport(roomId, result.graph, result.intent);
    void this.router.navigate(['/', roomId]);
  }
}
