import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, output, signal } from '@angular/core';
import { formatAge, formatRps, type HealthReport, type TimelineEntry } from '@keel/shared';
import { CollabService } from '../collab/collab.service';
import { HEALTH_LABELS } from '../core/labels';
import { IncidentModeService } from './incident-mode.service';

interface HotspotRow {
  report: HealthReport;
  kind: string;
  reason: string;
  affects: string | null;
  traffic: string | null;
}

interface TimelineRow {
  entry: TimelineEntry;
  ago: string;
  clock: string;
}

/** "12s ago", where age is a short duration from formatAge. */
function agoLabel(age: string): string {
  return $localize`:Time since an event; age is a short duration like 12s:${age}:age: ago`;
}

/**
 * Incident mode's panel, in the review dock's place: what is broken, ranked
 * for whoever holds the pager, and what changed shortly before.
 *
 * The canvas carries the map (health on every box, traffic on every line);
 * this carries the reading order. Ranking lives in `incidentView` (shared),
 * so it is tested without a browser.
 */
@Component({
  selector: 'keel-incident',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './incident.component.html',
  styleUrl: './incident.component.scss',
})
export class IncidentComponent {
  private readonly collab = inject(CollabService);
  private readonly mode = inject(IncidentModeService);

  readonly revealed = output<string>();

  /** Ages tick faster here than the app-wide clock: "12s ago" matters mid-incident. */
  private readonly now = signal(Date.now());

  readonly healthLabels = HEALTH_LABELS;
  /** Who made an approval, in the timeline: the approved design, not a person. */
  readonly designLabel = $localize`:Timeline author of an approval:design`;

  readonly view = this.collab.incident;
  readonly graphEmpty = computed(() => this.collab.graph().nodes.length === 0);

  readonly sources = computed(() =>
    (this.collab.report().evidence?.sources ?? []).map((source) => {
      const observed = Date.parse(source.observedAt);
      return {
        name: source.source,
        stale: source.stale,
        age: Number.isFinite(observed)
          ? agoLabel(formatAge(Math.max(0, this.now() - observed)))
          : $localize`:Observation source whose timestamp cannot be read:no valid time`,
      };
    }),
  );

  readonly hotspots = computed<HotspotRow[]>(() =>
    this.view().lookFirst.map((report) => ({
      report,
      kind: report.element === 'node' ? $localize`:Element type:Component` : $localize`:Element type:Dependency`,
      reason: report.reasons.join(' · '),
      affects: report.affects.length === 0 ? null : summarizeNames(report.affects),
      traffic: report.rps === undefined ? null : formatRps(report.rps),
    })),
  );

  readonly undiagrammed = computed(() => {
    const labels = new Map(this.collab.graph().nodes.map((n) => [n.id, n.label]));
    return (this.collab.report().evidence?.undiagrammed ?? []).map((call) => ({
      key: `${call.sourceId}:${call.targetId}`,
      label: $localize`:A call from one component to another:${labels.get(call.sourceId) ?? call.sourceId}:source: to ${
        labels.get(call.targetId) ?? call.targetId
      }:target:`,
      sourceId: call.sourceId,
      traffic: call.rps === undefined ? null : formatRps(call.rps),
    }));
  });

  readonly timeline = computed<TimelineRow[]>(() =>
    this.collab.timeline().map((entry) => {
      const at = Date.parse(entry.at);
      return {
        entry,
        ago: agoLabel(formatAge(Math.max(0, this.now() - at))),
        clock: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }),
  );

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 10_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  reveal(id: string | undefined): void {
    if (id) this.revealed.emit(id);
  }

  close(): void {
    this.mode.active.set(false);
  }
}

/** "A, B and 3 more": enough to judge the blast radius without a wall of names. */
function summarizeNames(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return $localize`:A list of names cut short:${names.slice(0, 3).join(', ')}:names: and ${names.length - 3}:count: more`;
}
