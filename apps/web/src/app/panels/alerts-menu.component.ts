import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
import type { Severity } from '@keel/shared';
import { firstValueFrom } from 'rxjs';
import { KEEL_CONFIG } from '../core/app-config';

/** The server's masked view: destinations are recognisable, never usable. */
interface AlertsView {
  config: {
    slack?: { webhookUrl: string; minSeverity: Severity };
    pagerduty?: { routingKey: string; minSeverity: Severity };
    checks: string[];
    resolveAfterMinutes: number;
  } | null;
  open: { ruleId: string; severity: Severity; title: string; since: string; delivered: string[] }[];
}

/**
 * Where this diagram's drift alerts go, in the view-tools bar beside Export.
 *
 * Credentials are write-only: a stored webhook or routing key comes back
 * masked and an empty field keeps it, so editing a threshold never requires
 * re-pasting a secret, and opening this panel never reveals one.
 */
@Component({
  selector: 'keel-alerts-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './alerts-menu.component.html',
  styleUrl: './alerts-menu.component.scss',
  host: {
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    // Document-level, not on the panel: saving disables the focused button,
    // which drops focus to <body>, and Escape must still close the panel.
    '(document:keydown.escape)': 'onEscape($event)',
  },
})
export class AlertsMenuComponent {
  private readonly http = inject(HttpClient);
  private readonly config = inject(KEEL_CONFIG);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly roomId = input.required<string>();

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly firstField = viewChild<ElementRef<HTMLInputElement>>('firstField');

  readonly severities: readonly Severity[] = ['error', 'warning', 'info'];

  readonly open = signal(false);
  readonly view = signal<AlertsView | null>(null);
  readonly busy = signal<'load' | 'save' | 'test' | 'off' | null>(null);
  readonly message = signal<{ tone: 'ok' | 'error'; text: string } | null>(null);

  readonly slackUrl = signal('');
  readonly slackSeverity = signal<Severity>('warning');
  readonly pagerdutyKey = signal('');
  readonly pagerdutySeverity = signal<Severity>('error');

  readonly configured = computed(() => this.view()?.config ?? null);
  readonly openCount = computed(() => this.view()?.open.length ?? 0);
  readonly summary = computed(() => {
    const config = this.configured();
    if (!config) return 'Off';
    return [config.slack ? 'Slack' : null, config.pagerduty ? 'PagerDuty' : null].filter(Boolean).join(' · ');
  });

  private get url(): string {
    return `${this.config.apiUrl}/api/rooms/${encodeURIComponent(this.roomId())}/alerts`;
  }

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.open.set(true);
    this.message.set(null);
    void this.load();
    afterNextRender(() => this.firstField()?.nativeElement.focus(), { injector: this.injector });
  }

  close(returnFocus = true): void {
    this.open.set(false);
    this.slackUrl.set('');
    this.pagerdutyKey.set('');
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  async load(): Promise<void> {
    this.busy.set('load');
    try {
      const view = await firstValueFrom(this.http.get<AlertsView>(this.url));
      this.view.set(view);
      if (view.config?.slack) this.slackSeverity.set(view.config.slack.minSeverity);
      if (view.config?.pagerduty) this.pagerdutySeverity.set(view.config.pagerduty.minSeverity);
    } catch (error) {
      this.fail(error, 'Could not load alert settings.');
    } finally {
      this.busy.set(null);
    }
  }

  async save(): Promise<void> {
    const current = this.configured();
    const slackUrl = this.slackUrl().trim();
    const pagerdutyKey = this.pagerdutyKey().trim();
    const body: Record<string, unknown> = {};
    // A blank secret on a configured channel means "keep the stored one".
    if (slackUrl || current?.slack) {
      body['slack'] = { ...(slackUrl ? { webhookUrl: slackUrl } : {}), minSeverity: this.slackSeverity() };
    }
    if (pagerdutyKey || current?.pagerduty) {
      body['pagerduty'] = { ...(pagerdutyKey ? { routingKey: pagerdutyKey } : {}), minSeverity: this.pagerdutySeverity() };
    }
    if (Object.keys(body).length === 0) {
      this.message.set({ tone: 'error', text: 'Add a Slack webhook or a PagerDuty integration key.' });
      return;
    }

    this.busy.set('save');
    try {
      await firstValueFrom(this.http.put(this.url, body));
      this.slackUrl.set('');
      this.pagerdutyKey.set('');
      await this.load();
      this.message.set({ tone: 'ok', text: 'Saved. Anything already drifting is sent now.' });
    } catch (error) {
      this.fail(error, 'Could not save.');
    } finally {
      this.busy.set(null);
    }
  }

  async sendTest(): Promise<void> {
    this.busy.set('test');
    try {
      const { results } = await firstValueFrom(
        this.http.post<{ results: Record<string, { ok: boolean; error?: string }> }>(`${this.url}/test`, {}),
      );
      const failed = Object.entries(results).filter(([, r]) => !r.ok);
      this.message.set(
        failed.length === 0
          ? { tone: 'ok', text: 'Test sent. Check the channel.' }
          : { tone: 'error', text: failed.map(([channel, r]) => `${channel}: ${r.error ?? 'failed'}`).join('; ') },
      );
    } catch (error) {
      this.fail(error, 'Could not send a test.');
    } finally {
      this.busy.set(null);
    }
  }

  async turnOff(): Promise<void> {
    this.busy.set('off');
    try {
      await firstValueFrom(this.http.delete(this.url));
      this.view.set({ config: null, open: [] });
      this.message.set({ tone: 'ok', text: 'Alerts are off for this diagram.' });
    } catch (error) {
      this.fail(error, 'Could not turn alerts off.');
    } finally {
      this.busy.set(null);
    }
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  asSeverity(value: string): Severity {
    return (this.severities as readonly string[]).includes(value) ? (value as Severity) : 'warning';
  }

  onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.close();
  }

  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }

  /** The server's own validation message is the useful one ("must be a hooks.slack.com URL"). */
  private fail(error: unknown, fallback: string): void {
    let text = fallback;
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { issues?: { message?: string }[]; error?: string } | null;
      text = body?.issues?.[0]?.message ?? body?.error ?? fallback;
      if (error.status === 429) text = 'Too many changes. Wait a minute and try again.';
    }
    this.message.set({ tone: 'error', text });
  }
}
