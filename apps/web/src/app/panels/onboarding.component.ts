import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CollabService } from '../collab/collab.service';
import { OnboardingService } from './onboarding.service';

interface Step {
  id: string;
  title: string;
  hint: string;
  done: boolean;
}

/**
 * A first-run checklist: the handful of actions that show what Keel is for,
 * each ticked off by doing it rather than by reading about it.
 */
@Component({
  selector: 'keel-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent {
  private readonly collab = inject(CollabService);
  private readonly progress = inject(OnboardingService);

  readonly expanded = signal(true);
  readonly copied = signal(false);

  readonly steps = computed<Step[]>(() => {
    const graph = this.collab.graph();
    return [
      {
        id: 'place',
        title: $localize`:Checklist step:Place two components`,
        hint: $localize`:Checklist step hint:Drag from the rail on the left, or click a tile and then the canvas.`,
        done: graph.nodes.length >= 2,
      },
      {
        id: 'connect',
        title: $localize`:Checklist step, connect the two components:Connect them`,
        hint: $localize`:Checklist step hint; Alt and Option are keyboard keys:Hold Alt (Option) and drag from one component to another.`,
        done: graph.edges.length >= 1,
      },
      {
        id: 'finding',
        title: $localize`:Checklist step:Read a finding`,
        hint: $localize`:Checklist step hint:Open the review dock at the bottom left and pick one. Click it to find it on the canvas.`,
        done: this.progress.has('read-finding'),
      },
      {
        id: 'approve',
        title: $localize`:Checklist step:Approve the design`,
        hint: $localize`:Checklist step hint; Approve design and Changes are UI labels:In the review dock, Approve design. From then on, every change shows up under Changes.`,
        done: this.collab.hasBaseline(),
      },
      {
        id: 'live',
        title: $localize`:Checklist step:Connect live data`,
        hint: $localize`:Checklist step hint:Run the collector in your cluster, or push a first set by hand with the command below.`,
        done: this.collab.observations().length > 0,
      },
      {
        id: 'share',
        title: $localize`:Checklist step:Bring in your team`,
        hint: $localize`:Checklist step hint; Share is a button label:Copy the room link (top left), or use Share to make it private to a workspace.`,
        done: this.progress.has('shared'),
      },
    ];
  });

  readonly doneCount = computed(() => this.steps().filter((s) => s.done).length);
  readonly next = computed(() => this.steps().find((s) => !s.done) ?? null);
  readonly visible = computed(
    () => !this.progress.dismissed() && this.doneCount() < this.steps().length && !this.collab.readOnly(),
  );

  /** A first observations push for this room, runnable as is in a POSIX shell. */
  readonly pushCommand = computed(() => {
    const url = `${location.origin}/api/rooms/${this.collab.roomId() ?? '<room>'}/observations`;
    const ref = this.collab.graph().nodes.find((n) => n.ref)?.ref ?? this.collab.graph().nodes[0]?.id ?? 'my-service';
    const now = `"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"`;
    return (
      `curl -X POST ${url} \\\n  -H 'content-type: application/json' \\\n` +
      `  -d '{"source":"manual","observedAt":${now},"nodes":[{"ref":"${ref}","replicas":1}]}'`
    );
  });

  async copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.pushCommand());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard blocked; the command is still on screen to select.
    }
  }

  dismiss(): void {
    this.progress.dismiss();
  }
}
