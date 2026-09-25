import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { formatAge, formatRps, type Finding, type ObservationSet, type Severity } from '@keel/shared';
import { CollabService } from '../collab/collab.service';
import { ReviewService } from './review.service';

interface FindingRow {
  finding: Finding;
  targetId: string | null;
}

@Component({
  selector: 'keel-findings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './findings.component.html',
  styleUrl: './findings.component.scss',
})
export class FindingsComponent {
  private readonly collab = inject(CollabService);
  protected readonly review = inject(ReviewService);

  readonly revealed = output<string>();

  /**
   * Collapsed by default: a dock permanently open over the canvas is the same
   * chrome-tax the old docked panel was, just relocated. Collapsed, it is one
   * pill with the counts that matter; expanding is one click away whenever
   * there is something to actually read.
   */
  readonly expanded = signal(false);

  readonly report = computed(() => this.collab.report());
  readonly graphEmpty = computed(() => this.collab.graph().nodes.length === 0);
  readonly staleReview = computed(
    () => this.review.hasRun() && this.review.isStale(this.collab.effectiveGraph()),
  );

  readonly hasBaseline = this.collab.hasBaseline;
  readonly hasUnapprovedChanges = this.collab.hasUnapprovedChanges;
  readonly importError = signal<string | null>(null);

  /** One row per observation source, with how fresh it is and what it matched. */
  readonly sources = computed(() =>
    (this.report().evidence?.sources ?? []).map((source) => ({
      ...source,
      age: Number.isFinite(source.ageMs) ? `${formatAge(source.ageMs)} ago` : 'no valid time',
      matched: source.matchedNodeIds.length + source.matchedEdgeIds.length,
    })),
  );

  readonly ruleRows = computed<FindingRow[]>(() => this.report().findings.map(toRow));
  readonly aiRows = computed<FindingRow[]>(() => this.review.findings().map(toRow));
  readonly totalCount = computed(() => this.ruleRows().length + this.aiRows().length);

  readonly buckets = computed(() => {
    const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
    for (const row of [...this.ruleRows(), ...this.aiRows()]) counts[row.finding.severity] += 1;

    return (['error', 'warning', 'info'] as const)
      .filter((severity) => counts[severity] > 0)
      .map((severity) => ({
        severity,
        count: counts[severity],
        label: counts[severity] === 1 ? LABELS[severity].one : LABELS[severity].many,
      }));
  });

  readonly scoreClass = computed(() => {
    const score = this.report().score;
    if (score >= 85) return 'good';
    if (score >= 60) return 'fair';
    return 'poor';
  });

  constructor() {
    void this.review.loadModels();
  }

  reveal(row: FindingRow): void {
    if (row.targetId) this.revealed.emit(row.targetId);
  }

  toggleExpanded(): void {
    this.expanded.update((current) => !current);
  }

  pickModel(event: Event): void {
    this.review.selectModel((event.target as HTMLSelectElement).value);
  }

  runReview(): void {
    void this.review.review(this.collab.effectiveGraph());
  }

  /** The label on a finding's one-click resolution, or null when it has none. */
  fixLabel(finding: Finding): string | null {
    switch (finding.fix) {
      case 'accept-observed':
        return 'Match running system';
      case 'approve':
        return 'Approve';
      default:
        return null;
    }
  }

  applyFix(finding: Finding): void {
    const deltas = finding.deltas ?? [];
    if (finding.fix === 'accept-observed') this.collab.acceptObserved(deltas);
    else if (finding.fix === 'approve') this.collab.approve([...new Set(deltas.map((d) => d.elementId))]);
  }

  trafficLabel(finding: Finding): string | null {
    if (finding.trafficRps === undefined) return null;
    return finding.trafficRps === 0 ? 'no traffic' : formatRps(finding.trafficRps);
  }

  approveAll(): void {
    this.collab.approveAll();
  }

  removeSource(source: string): void {
    this.collab.removeObservations(source);
  }

  /**
   * Load observations from a JSON file: one set, or an array of them.
   *
   * The same shape the server's ingest route accepts, so a file a script
   * produced for CI can be dropped in by hand to try it out first.
   */
  async importFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.importError.set(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const sets = (Array.isArray(parsed) ? parsed : [parsed]).map(toObservationSet);
      for (const set of sets) this.collab.importObservations(set);
    } catch (error) {
      this.importError.set(error instanceof Error ? error.message : 'Could not read that file.');
    }
  }
}

function toObservationSet(value: unknown): ObservationSet {
  if (typeof value !== 'object' || value === null) throw new Error('Expected an object with source and observedAt.');
  const set = value as Partial<ObservationSet>;
  if (typeof set.source !== 'string' || set.source.trim() === '') throw new Error('Each set needs a "source".');
  if (typeof set.observedAt !== 'string' || Number.isNaN(Date.parse(set.observedAt))) {
    throw new Error(`"${set.source}" needs an ISO "observedAt" time.`);
  }
  return {
    source: set.source.trim(),
    observedAt: set.observedAt,
    nodes: Array.isArray(set.nodes) ? set.nodes : [],
    edges: Array.isArray(set.edges) ? set.edges : [],
  };
}

function toRow(finding: Finding): FindingRow {
  // Prefer the edge. A finding like "X calls Y with no timeout" is about the
  // dependency, and selecting it is what opens the timeout field in the
  // inspector. Revealing a node instead leaves the user staring at a box with
  // no obvious way to reach the property the finding is complaining about.
  return { finding, targetId: finding.edgeIds[0] ?? finding.nodeIds[0] ?? null };
}

const LABELS: Record<Severity, { one: string; many: string }> = {
  error: { one: 'error', many: 'errors' },
  warning: { one: 'warning', many: 'warnings' },
  info: { one: 'note', many: 'notes' },
};
