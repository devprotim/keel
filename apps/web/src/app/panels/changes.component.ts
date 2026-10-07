import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { FIELD_LABELS, formatAge, formatFieldValue, type FieldChange, type ReviewChange } from '@keel/shared';
import { CollabService } from '../collab/collab.service';

interface FieldRow {
  field: string;
  label: string;
  approved: string;
  current: string;
  /** "Approved by ada, 2h ago", for a field that had an approval. */
  approvedBy: string | null;
  blocked: string | null;
}

interface ChangeRow {
  change: ReviewChange;
  what: string;
  fields: FieldRow[];
  /** For an added or removed element: its settings in one line. */
  summary: string;
}

/**
 * Review mode: the diagram's changes since approval, taken one at a time.
 *
 * Every change can be approved into the baseline or rejected back out of the
 * diagram, per field where a field is what changed. Both go through the same
 * GraphDoc operations as everything else, so each click is one undo step and
 * reaches collaborators live.
 */
@Component({
  selector: 'keel-changes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './changes.component.html',
  styleUrl: './changes.component.scss',
})
export class ChangesComponent {
  private readonly collab = inject(CollabService);

  readonly revealed = output<string>();

  readonly readOnly = this.collab.readOnly;
  readonly hasBaseline = this.collab.hasBaseline;
  readonly graphEmpty = computed(() => this.collab.graph().nodes.length === 0);

  readonly rows = computed<ChangeRow[]>(() => {
    const labels = new Map(this.collab.graph().nodes.map((n) => [n.id, n.label]));
    const intent = this.collab.intent();
    const nameOf = (id: string): string => labels.get(id) ?? intent[id]?.label ?? id;
    const now = Date.now();

    return this.collab.changes().map((change) => ({
      change,
      what: WHAT[change.element === 'node' ? 'node' : 'edge'][change.type],
      fields: change.fields.map((f) => fieldRow(f, nameOf, now)),
      summary: summarize(change, nameOf),
    }));
  });

  readonly counts = computed(() => {
    const counts = { added: 0, removed: 0, changed: 0 };
    for (const change of this.collab.changes()) counts[change.type] += 1;
    return counts;
  });

  reveal(change: ReviewChange): void {
    if (change.type !== 'removed') this.revealed.emit(change.id);
  }

  approve(change: ReviewChange, field?: string): void {
    if (field) this.collab.approveFields(change.id, [field]);
    else this.collab.approve([change.id]);
  }

  reject(change: ReviewChange, field?: string): void {
    this.collab.reject([{ id: change.id, ...(field ? { fields: [field] } : {}) }]);
  }

  approveAll(): void {
    this.collab.approveAll();
  }

  /** Everything back to the approved design. Blocked changes are left as they are. */
  rejectAll(): void {
    this.collab.reject(this.collab.changes().filter((c) => !c.blocked).map((c) => ({ id: c.id })));
  }

  approveLabel(change: ReviewChange): string {
    return change.type === 'removed' ? $localize`:Approve a removal:Approve removal` : $localize`:Approve a change:Approve`;
  }

  rejectLabel(change: ReviewChange): string {
    return change.type === 'removed'
      ? $localize`:Reject a removal:Restore`
      : change.type === 'added'
        ? $localize`:Reject an addition:Remove`
        : $localize`:Reject a change:Revert`;
  }

  /** The action buttons' accessible names: the action and the element's name, as one sentence. */
  approveAriaLabel(change: ReviewChange): string {
    const label = change.label;
    return change.type === 'removed'
      ? $localize`:Approve a removal, followed by the element name:Approve removal ${label}:label:`
      : $localize`:Approve a change, followed by the element name:Approve ${label}:label:`;
  }

  rejectAriaLabel(change: ReviewChange): string {
    const label = change.label;
    return change.type === 'removed'
      ? $localize`:Reject a removal, followed by the element name:Restore ${label}:label:`
      : change.type === 'added'
        ? $localize`:Reject an addition, followed by the element name:Remove ${label}:label:`
        : $localize`:Reject a change, followed by the element name:Revert ${label}:label:`;
  }

  revealTitle(change: ReviewChange): string {
    return change.type === 'removed'
      ? $localize`:Tooltip on a removed element in review mode:Shown faded on the canvas where it was`
      : $localize`:Tooltip on a change in review mode:Show on the canvas`;
  }

  approvedValueLabel(field: FieldRow): string {
    return $localize`:Accessible name of a field's approved value:approved ${field.approved}:value:`;
  }

  currentValueLabel(field: FieldRow): string {
    return $localize`:Accessible name of a field's current value:now ${field.current}:value:`;
  }

  revertFieldTitle(field: FieldRow): string {
    return $localize`:Tooltip on a field's Revert button:Put ${field.label}:field: back to ${field.approved}:value:`;
  }

  revertFieldLabel(field: FieldRow, change: ReviewChange): string {
    return $localize`:Revert one field of an element:Revert ${field.label}:field: on ${change.label}:element:`;
  }

  approveFieldLabel(field: FieldRow, change: ReviewChange): string {
    return $localize`:Approve one field of an element:Approve ${field.label}:field: on ${change.label}:element:`;
  }
}

/** What happened to an element, as whole phrases rather than a noun glued to a verb. */
const WHAT: Record<'node' | 'edge', Record<ReviewChange['type'], string>> = {
  node: {
    added: $localize`:Review change kind:Component added`,
    removed: $localize`:Review change kind:Component removed`,
    changed: $localize`:Review change kind:Component changed`,
  },
  edge: {
    added: $localize`:Review change kind:Dependency added`,
    removed: $localize`:Review change kind:Dependency removed`,
    changed: $localize`:Review change kind:Dependency changed`,
  },
};

function fieldRow(change: FieldChange, nameOf: (id: string) => string, now: number): FieldRow {
  const approvedAt = change.approved ? Date.parse(change.approved.at) : NaN;
  return {
    field: change.field,
    label: FIELD_LABELS[change.field] ?? change.field,
    approved: formatFieldValue(change.field, change.approved?.value, nameOf),
    current: formatFieldValue(change.field, change.current, nameOf),
    approvedBy: change.approved ? approvedByLabel(change.approved.by, approvedAt, now) : null,
    blocked: change.blocked ?? null,
  };
}

function approvedByLabel(by: string, approvedAt: number, now: number): string {
  if (!Number.isFinite(approvedAt)) return $localize`:Who approved a field:Approved by ${by}:name:`;
  const age = formatAge(now - approvedAt);
  return $localize`:Who approved a field and how long ago:Approved by ${by}:name:, ${age}:age: ago`;
}

/**
 * The settings that matter for an added or removed element, in one line:
 * the fields that are set, skipping the ones at their defaults.
 */
function summarize(change: ReviewChange, nameOf: (id: string) => string): string {
  if (change.type === 'changed') return '';
  const parts: string[] = [];
  for (const f of change.fields) {
    const value = change.type === 'added' ? f.current : f.approved?.value;
    if (value === undefined || value === null || value === false || value === '') continue;
    if (f.field === 'source' || f.field === 'target') continue;
    if (f.field === 'retries' && value === 0) continue;
    if (f.field === 'kind') parts.push(String(value));
    else if (f.field === 'replicas') {
      parts.push(value === 1 ? $localize`:Replica count, one:1 instance` : $localize`:Replica count, several:${String(value)}:count: instances`);
    }
    else if (typeof value === 'boolean') parts.push((FIELD_LABELS[f.field] ?? f.field).toLowerCase());
    else parts.push(`${(FIELD_LABELS[f.field] ?? f.field).toLowerCase()} ${formatFieldValue(f.field, value, nameOf)}`);
  }
  return parts.join(' · ');
}
