import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { CollabService } from '../collab/collab.service';
import {
  downloadBlob,
  exportFilename,
  exportJson,
  exportPng,
  exportSvg,
} from '../canvas/export';
import type { CanvasTheme } from '../core/theme';

type ExportFormat = 'png' | 'svg' | 'json';

/**
 * The Export button and its menu, in the view-tools bar.
 *
 * A native-feeling menu, hand-rolled rather than pulled in from the Angular
 * CDK: three items and one checkbox do not justify a new dependency, and the
 * keyboard contract (arrows, Escape, focus return) is a few lines here.
 */
@Component({
  selector: 'keel-export-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './export-menu.component.html',
  styleUrl: './export-menu.component.scss',
  host: {
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
  },
})
export class ExportMenuComponent {
  private readonly collab = inject(CollabService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly roomId = input.required<string>();
  /** The canvas's current palette, so the export matches what is on screen. */
  readonly theme = input.required<CanvasTheme>();

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  readonly open = signal(false);
  readonly busy = signal<ExportFormat | null>(null);
  readonly error = signal<string | null>(null);
  /**
   * Off by default: an exported diagram usually lands in a design doc or a
   * slide, where a red badge with no findings list next to it only raises a
   * question the reader cannot answer.
   */
  readonly includeFindings = signal(false);
  readonly empty = computed(() => this.collab.graph().nodes.length === 0);

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.error.set(null);
    this.open.set(true);
    // After render, so the menu items exist to receive focus.
    afterNextRender(() => this.items()[0]?.focus(), { injector: this.injector });
  }

  close(returnFocus = true): void {
    this.open.set(false);
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  async export(format: ExportFormat): Promise<void> {
    if (this.busy()) return;
    this.busy.set(format);
    this.error.set(null);

    const graph = this.collab.graph();
    const options = { findings: this.includeFindings() };
    try {
      const blob =
        format === 'png'
          ? await exportPng(graph, this.collab.report(), this.theme(), options)
          : format === 'svg'
            ? await exportSvg(graph, this.collab.report(), this.theme(), options)
            : exportJson(graph, this.collab.intent());
      downloadBlob(blob, exportFilename(this.roomId(), format));
      this.close();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      this.busy.set(null);
    }
  }

  onMenuKeydown(event: KeyboardEvent): void {
    const items = this.items();
    const index = items.indexOf(document.activeElement as HTMLElement);

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        items.at(-1)?.focus();
        break;
      case 'Tab':
        // Tabbing out of a menu closes it, as a native one does.
        this.close(false);
        break;
    }
  }

  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }

  private items(): HTMLElement[] {
    const menu = this.menu()?.nativeElement;
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')] : [];
  }
}
