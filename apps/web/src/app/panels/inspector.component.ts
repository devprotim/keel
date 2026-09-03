import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { EDGE_KINDS, NODE_KINDS, type ArchEdge, type ArchNode, type EdgeKind, type NodeKind } from '@keel/shared';
import { CollabService } from '../collab/collab.service';

/**
 * Property editor for the current selection.
 *
 * Every field here feeds the validation engine: a timeout typed into this panel
 * changes the findings list on the next keystroke. That immediacy is the point,
 * and it is why the rule engine runs on the client rather than only on the
 * server.
 */
@Component({
  selector: 'keel-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inspector.component.html',
  styleUrl: './inspector.component.scss',
})
export class InspectorComponent {
  private readonly collab = inject(CollabService);

  readonly selection = input.required<ReadonlySet<string>>();

  readonly nodeKinds = NODE_KINDS;
  readonly edgeKinds = EDGE_KINDS;

  /** The single selected node, or null for a multi or edge selection. */
  readonly node = computed<ArchNode | null>(() => {
    const ids = this.selection();
    if (ids.size !== 1) return null;
    const [id] = ids;
    return this.collab.graph().nodes.find((n) => n.id === id) ?? null;
  });

  readonly edge = computed<ArchEdge | null>(() => {
    const ids = this.selection();
    if (ids.size !== 1) return null;
    const [id] = ids;
    return this.collab.graph().edges.find((e) => e.id === id) ?? null;
  });

  readonly title = computed(() => {
    if (this.node()) return 'Component';
    if (this.edge()) return 'Dependency';
    return 'Inspector';
  });

  readonly emptyMessage = computed(() =>
    this.selection().size > 1
      ? `${this.selection().size} items selected. Select a single item to edit it.`
      : 'Select a component or dependency to edit its properties.',
  );

  patchNode(id: string, patch: Partial<ArchNode>): void {
    this.collab.updateNode(id, patch);
  }

  patchEdge(id: string, patch: Partial<ArchEdge>): void {
    this.collab.updateEdge(id, patch);
  }

  edgeKindHint(kind: EdgeKind): string {
    switch (kind) {
      case 'sync':
        return 'The caller blocks, so failures propagate upstream.';
      case 'async':
        return 'Fire and forget through a broker. Delivery is at least once.';
      case 'stream':
        return 'A continuous subscription. Ordering and replay matter.';
    }
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  /**
   * Empty input means "no value", not zero.
   *
   * Returning 0 for a cleared timeout field would silently claim an instant
   * timeout, which is a very different design from an unbounded one.
   */
  numeric(event: Event): number | undefined {
    const raw = (event.target as HTMLInputElement).value.trim();
    if (raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  // The select element only ever contains valid kinds, so this is a cast at the
  // template boundary rather than a validation step.
  asNodeKind(value: string): NodeKind {
    return value as NodeKind;
  }

  asEdgeKind(value: string): EdgeKind {
    return value as EdgeKind;
  }
}
