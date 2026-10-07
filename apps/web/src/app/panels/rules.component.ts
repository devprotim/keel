import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { findingKey, formatAge, type RuleStats, type Severity } from '@keel/shared';
import { CollabService } from '../collab/collab.service';

interface RuleRow {
  stats: RuleStats;
  /** "Fired 4 times this week · 2 noise, 1 real (67% noise) · fixed in 3h" */
  measured: string;
  /** Worth a second look: most of what it raised here was judged noise. */
  noisy: boolean;
}

/**
 * The Rules tab of the review dock: tune each check for this room, next to the
 * numbers that say whether it should be.
 *
 * Settings apply to everyone in the room and to its alerts. Labels are
 * collected from the Findings tab; this is where they add up.
 */
@Component({
  selector: 'keel-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rules.component.html',
  styleUrl: './rules.component.scss',
})
export class RulesComponent {
  private readonly collab = inject(CollabService);

  readonly readOnly = this.collab.readOnly;
  readonly severities: readonly Severity[] = ['error', 'warning', 'info'];

  /** The rules worth tuning first: mostly noise, then busiest now, then busiest this week. */
  readonly rows = computed<RuleRow[]>(() =>
    this.collab
      .ruleStats()
      .map((stats) => ({
        stats,
        measured: describe(stats),
        noisy: stats.noiseRate !== undefined && stats.noise >= 2 && stats.noiseRate >= 0.5,
      }))
      .sort((a, b) => Number(b.noisy) - Number(a.noisy) || b.stats.firing - a.stats.firing || b.stats.fired - a.stats.fired),
  );

  readonly labelCount = computed(() => Object.keys(this.collab.labels()).length);

  alwaysLabel(severity: Severity): string {
    return ALWAYS[severity];
  }

  setSeverity(stats: RuleStats, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const next = { ...stats.setting };
    if (value === '') delete next.severity;
    else next.severity = value as Severity;
    this.collab.setRuleSetting(stats.id, next);
  }

  setMuted(stats: RuleStats, event: Event): void {
    const next = { ...stats.setting };
    if ((event.target as HTMLInputElement).checked) next.muted = true;
    else delete next.muted;
    this.collab.setRuleSetting(stats.id, next);
  }

  /**
   * Download this room's labels with what each labelled finding said, the
   * dataset for deciding what counts as noise across design partners.
   */
  exportLabels(): void {
    const report = this.collab.report();
    const byKey = new Map([...report.findings, ...report.dismissed].map((f) => [findingKey(f), f]));
    const labels = Object.entries(this.collab.labels()).map(([key, label]) => {
      const finding = byKey.get(key);
      return { key, ...label, ...(finding ? { severity: finding.severity, title: finding.title } : { firing: false }) };
    });
    const body = JSON.stringify(
      { room: this.collab.roomId(), exportedAt: new Date().toISOString(), labels, rules: this.collab.ruleStats() },
      null,
      2,
    );

    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `keel-labels-${this.collab.roomId() ?? 'room'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

/** Severity override options, one whole phrase per severity. */
const ALWAYS: Record<Severity, string> = {
  error: $localize`:Rule severity override option:Always error`,
  warning: $localize`:Rule severity override option:Always warning`,
  info: $localize`:Rule severity override option:Always info`,
};

function describe(stats: RuleStats): string {
  const parts: string[] = [];
  const fired = stats.fired;
  parts.push(
    fired === 0
      ? $localize`:Rule stats, never fired:Not fired this week`
      : fired === 1
        ? $localize`:Rule stats, fired once:Fired 1 time this week`
        : $localize`:Rule stats, fired several times:Fired ${fired}:count: times this week`,
  );
  if (stats.real + stats.noise > 0) {
    const noise = stats.noise;
    const real = stats.real;
    const percent = Math.round((stats.noiseRate ?? 0) * 100);
    parts.push($localize`:Rule stats, labels:${noise}:noise: noise, ${real}:real: real (${percent}:percent:% noise)`);
  }
  if (stats.medianOpenMs !== undefined) {
    const age = formatAge(stats.medianOpenMs);
    parts.push($localize`:Rule stats, median time a finding stays open:typically resolved in ${age}:age:`);
  }
  return parts.join(' · ');
}
