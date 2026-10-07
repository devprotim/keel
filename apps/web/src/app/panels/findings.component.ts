import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, output, signal } from '@angular/core';
import {
  createNode,
  formatAge,
  formatRps,
  type Finding,
  type NodeSuggestion,
  type ObservationSet,
  type Severity,
  type Verdict,
} from '@keel/shared';
import { CollabService } from '../collab/collab.service';
import { SEVERITY_LABELS } from '../core/labels';
import { ChangeReviewService } from './change-review.service';
import { ChangesComponent } from './changes.component';
import { RulesComponent } from './rules.component';
import { OnboardingService } from './onboarding.service';
import { ReviewService } from './review.service';

interface FindingRow {
  finding: Finding;
  targetId: string | null;
}

@Component({
  selector: 'keel-findings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChangesComponent, RulesComponent],
  templateUrl: './findings.component.html',
  styleUrl: './findings.component.scss',
})
export class FindingsComponent {
  private readonly collab = inject(CollabService);
  protected readonly review = inject(ReviewService);
  private readonly onboarding = inject(OnboardingService);

  readonly revealed = output<string>();

  /**
   * Collapsed by default: a dock permanently open over the canvas is the same
   * chrome-tax the old docked panel was, just relocated. Collapsed, it is one
   * pill with the counts that matter; expanding is one click away whenever
   * there is something to actually read.
   */
  readonly expanded = signal(false);

  /**
   * Findings, or the changes since approval. Showing the changes is review
   * mode: the canvas swaps severity for the diff while it is open.
   */
  readonly tab = signal<'findings' | 'changes' | 'rules'>('findings');
  readonly changeCount = computed(() => this.collab.changes().length);

  readonly report = computed(() => this.collab.report());
  readonly graphEmpty = computed(() => this.collab.graph().nodes.length === 0);
  readonly staleReview = computed(
    () => this.review.hasRun() && this.review.isStale(this.collab.effectiveGraph()),
  );

  /** Viewers see findings but not the controls that would change the diagram. */
  readonly readOnly = this.collab.readOnly;
  readonly hasBaseline = this.collab.hasBaseline;
  readonly hasUnapprovedChanges = this.collab.hasUnapprovedChanges;
  readonly importError = signal<string | null>(null);

  /** One row per observation source, with how fresh it is and what it matched. */
  readonly sources = computed(() =>
    (this.report().evidence?.sources ?? []).map((source) => ({
      ...source,
      age: Number.isFinite(source.ageMs)
        ? $localize`:Observation source age:${formatAge(source.ageMs)}:age: ago`
        : $localize`:Observation source with an unreadable time:no valid time`,
      matched: source.matchedNodeIds.length + source.matchedEdgeIds.length,
    })),
  );

  readonly ruleRows = computed<FindingRow[]>(() => this.report().findings.map(toRow));
  readonly dismissed = computed(() => this.report().dismissed);
  readonly showDismissed = signal(false);
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
        text: counts[severity] === 1 ? LABELS[severity].one() : LABELS[severity].many(counts[severity]),
      }));
  });

  /** The collapsed pill's accessible name: whole sentences, so each can be translated in its own word order. */
  readonly pillLabel = computed(() => {
    const score = this.report().score;
    const total = this.totalCount();
    const changes = this.changeCount();
    const summary =
      total === 0
        ? $localize`:Collapsed review pill label:Review: ${score}:score: out of 100. No issues found.`
        : $localize`:Collapsed review pill label:Review: ${score}:score: out of 100. ${total}:count: issues. Expand to see them.`;
    return changes > 0 ? `${summary} ${$localize`:Collapsed review pill label, appended:${changes}:count: changes since approval.`}` : summary;
  });

  readonly scoreClass = computed(() => {
    const score = this.report().score;
    if (score >= 85) return 'good';
    if (score >= 60) return 'fair';
    return 'poor';
  });

  constructor() {
    void this.review.loadModels();

    const changeReview = inject(ChangeReviewService);
    effect(() => changeReview.active.set(this.expanded() && this.tab() === 'changes'));
    // The dock leaves the page in incident mode, and review mode with it.
    inject(DestroyRef).onDestroy(() => changeReview.active.set(false));
  }

  showChanges(): void {
    this.tab.set('changes');
    this.expanded.set(true);
  }

  reveal(row: FindingRow): void {
    this.onboarding.mark('read-finding');
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
        return $localize`:Finding fix button:Match running system`;
      case 'approve':
        return $localize`:Finding fix button:Approve`;
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
    return finding.trafficRps === 0 ? $localize`:Finding traffic badge:no traffic` : formatRps(finding.trafficRps);
  }

  severityLabel(severity: Severity): string {
    return SEVERITY_LABELS[severity];
  }

  verdictLabel(finding: Finding): string {
    return $localize`:Verdict button group label, followed by the finding title:Is this a real problem? ${finding.title}:title:`;
  }

  removeSourceLabel(source: string): string {
    return $localize`:Remove observation source button:Remove observations from ${source}:source:`;
  }

  approveAll(): void {
    this.collab.approveAll();
  }

  label(finding: Finding, verdict: Verdict): void {
    this.collab.label(finding, verdict);
  }

  restore(finding: Finding): void {
    this.collab.clearLabel(finding);
  }

  suggestionsFor(source: string): readonly NodeSuggestion[] {
    return this.collab.nodeSuggestions().filter((s) => s.source === source);
  }

  /** Link a reported name to its box, or draw the box production runs, right of the diagram. */
  applySuggestion(suggestion: NodeSuggestion): void {
    if (suggestion.type === 'link') {
      this.collab.batch(() => this.collab.updateNode(suggestion.nodeId, { ref: suggestion.ref }));
      return;
    }
    const nodes = this.collab.graph().nodes;
    const right = nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.x + n.w)) + 80;
    const top = nodes.length === 0 ? 0 : Math.min(...nodes.map((n) => n.y));
    const node = createNode(suggestion.kind, right, top);
    this.collab.addNode({ ...node, label: suggestion.label, ref: suggestion.ref });
    this.revealed.emit(node.id);
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
      this.importError.set(error instanceof Error ? error.message : $localize`:Observation import error:Could not read that file.`);
    }
  }
}

function toObservationSet(value: unknown): ObservationSet {
  if (typeof value !== 'object' || value === null) throw new Error($localize`:Observation import error:Expected an object with source and observedAt.`);
  const set = value as Partial<ObservationSet>;
  if (typeof set.source !== 'string' || set.source.trim() === '') throw new Error($localize`:Observation import error:Each set needs a "source".`);
  if (typeof set.observedAt !== 'string' || Number.isNaN(Date.parse(set.observedAt))) {
    throw new Error($localize`:Observation import error:"${set.source}:source:" needs an ISO "observedAt" time.`);
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

/** Severity counts as whole phrases, so the number can sit wherever a language puts it. */
const LABELS: Record<Severity, { one: () => string; many: (count: number) => string }> = {
  error: {
    one: () => $localize`:Finding count, one error:1 error`,
    many: (count) => $localize`:Finding count, several errors:${count}:count: errors`,
  },
  warning: {
    one: () => $localize`:Finding count, one warning:1 warning`,
    many: (count) => $localize`:Finding count, several warnings:${count}:count: warnings`,
  },
  info: {
    one: () => $localize`:Finding count, one note (info severity):1 note`,
    many: (count) => $localize`:Finding count, several notes (info severity):${count}:count: notes`,
  },
};

