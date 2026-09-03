import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import type { Finding, Severity } from '@keel/shared';
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

  readonly report = computed(() => this.collab.report());
  readonly graphEmpty = computed(() => this.collab.graph().nodes.length === 0);
  readonly staleReview = computed(
    () => this.review.hasRun() && this.review.isStale(this.collab.graph()),
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
    if (score >= 85) return 'keel-findings__score--good';
    if (score >= 60) return 'keel-findings__score--fair';
    return 'keel-findings__score--poor';
  });

  constructor() {
    void this.review.loadModels();
  }

  reveal(row: FindingRow): void {
    if (row.targetId) this.revealed.emit(row.targetId);
  }

  pickModel(event: Event): void {
    this.review.selectModel((event.target as HTMLSelectElement).value);
  }

  runReview(): void {
    void this.review.review(this.collab.graph());
  }
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
