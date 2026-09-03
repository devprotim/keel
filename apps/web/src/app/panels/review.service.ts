import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { ArchGraph, Finding } from '@keel/shared';
import { graphFingerprint } from '@keel/shared';
import { firstValueFrom } from 'rxjs';
import { KEEL_CONFIG } from '../core/app-config';

interface ReviewResponse {
  findings: Finding[];
  fingerprint: string;
  cached: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  provider: string;
  model: string;
}

/**
 * The model-assisted review.
 *
 * Kept apart from the deterministic rules on purpose. Those are free, instant and
 * always correct; this one costs money, takes seconds and is a judgement call.
 * Treating them as one list would blur a distinction the user should be able to
 * see.
 */
@Injectable({ providedIn: 'root' })
export class ReviewService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(KEEL_CONFIG);

  private readonly _findings = signal<readonly Finding[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _reviewedFingerprint = signal<string | null>(null);
  private readonly _model = signal<string | null>(null);
  private readonly _models = signal<readonly string[]>([]);
  private readonly _selectedModel = signal<string | null>(null);
  private readonly _provider = signal<string | null>(null);

  readonly findings = this._findings.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  /** Which model produced the current findings, so the review is attributable. */
  readonly model = this._model.asReadonly();
  /** Models the server's configured credential can call. */
  readonly models = this._models.asReadonly();
  readonly selectedModel = this._selectedModel.asReadonly();
  readonly provider = this._provider.asReadonly();

  /**
   * Whether the diagram has changed since the last review.
   *
   * Drives a "results are stale" hint rather than auto-refetching: re-running a
   * paid review on every keystroke would be both slow and expensive.
   */
  isStale(graph: ArchGraph): boolean {
    const reviewed = this._reviewedFingerprint();
    return reviewed !== null && reviewed !== graphFingerprint(graph);
  }

  readonly hasRun = computed(() => this._reviewedFingerprint() !== null);

  /**
   * Fetch the model list once.
   *
   * Failure is silent by design: the picker simply does not appear, and review
   * still works on the server's default model. A broken dropdown should not
   * block the feature it decorates.
   */
  async loadModels(): Promise<void> {
    if (this._models().length > 0) return;

    try {
      const response = await firstValueFrom(
        this.http.get<{ provider: string; defaultModel: string; models: string[] }>(
          `${this.config.apiUrl}/api/review/models`,
        ),
      );
      this._models.set(response.models);
      this._provider.set(response.provider);
      this._selectedModel.set(response.defaultModel);
    } catch {
      this._models.set([]);
    }
  }

  selectModel(model: string): void {
    this._selectedModel.set(model);
  }

  async review(graph: ArchGraph): Promise<void> {
    if (this._loading()) return;

    this._loading.set(true);
    this._error.set(null);

    try {
      const model = this._selectedModel();
      const url = model
        ? `${this.config.apiUrl}/api/review?model=${encodeURIComponent(model)}`
        : `${this.config.apiUrl}/api/review`;

      const response = await firstValueFrom(this.http.post<ReviewResponse>(url, graph));
      this._findings.set(response.findings);
      this._reviewedFingerprint.set(response.fingerprint);
      this._model.set(response.model);
    } catch (error) {
      this._findings.set([]);
      this._error.set(describe(error));
    } finally {
      this._loading.set(false);
    }
  }

  clear(): void {
    this._findings.set([]);
    this._reviewedFingerprint.set(null);
    this._model.set(null);
    this._error.set(null);
  }
}

function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: number }).status;
    // 503 is the specific, actionable case: the server is running but has no
    // API key, which is a configuration problem rather than a failure.
    if (status === 503) return 'Review is not configured on the server.';
    if (status === 0) return 'Could not reach the server.';
    if (status === 400) return 'The diagram could not be reviewed.';
  }
  return 'The review failed. Try again in a moment.';
}
