import { graphFingerprint, type ArchGraph, type Finding } from '@keel/shared';
import type { RawFinding, ReviewProvider, ReviewUsage } from './provider.ts';
import { serializeGraph } from './serialize.ts';

/**
 * The AI review is a second opinion, not the product.
 *
 * Deterministic rules already catch what is mechanically checkable. This exists
 * for the judgement calls a rule cannot express: whether a boundary is drawn in
 * the right place, whether two components should be one, whether the failure
 * mode nobody drew is the one that matters.
 *
 * The vendor lives behind ReviewProvider. Caching and grounding stay here, so
 * both providers get the same guarantees rather than each reimplementing them.
 */

export interface ReviewResult {
  findings: Finding[];
  fingerprint: string;
  usage: ReviewUsage;
  /** Which provider produced this, surfaced so the UI can attribute it. */
  provider: string;
  model: string;
  /** True when served from cache without calling the model. */
  cached: boolean;
}

export interface ReviewerOptions {
  provider: ReviewProvider;
  /** Maximum reviews retained in the cache. */
  cacheSize?: number;
}

export class ArchitectureReviewer {
  readonly #provider: ReviewProvider;
  readonly #cacheSize: number;
  /** Insertion-ordered, so the oldest key is the first one Map iteration yields. */
  readonly #cache = new Map<string, ReviewResult>();
  #models: Promise<string[]> | undefined;

  constructor(options: ReviewerOptions) {
    this.#provider = options.provider;
    this.#cacheSize = options.cacheSize ?? 100;
  }

  get providerName(): string {
    return this.#provider.name;
  }

  get defaultModel(): string {
    return this.#provider.model;
  }

  /** Models the configured credential can call. Cached for the process lifetime. */
  async listModels(): Promise<string[]> {
    this.#models ??= this.#provider.listModels().catch(() => {
      // A failed listing must not be cached as a permanent empty result, or the
      // dropdown stays broken until restart.
      this.#models = undefined;
      return [];
    });
    return this.#models;
  }

  async review(graph: ArchGraph, model?: string): Promise<ReviewResult> {
    const fingerprint = graphFingerprint(graph);
    const chosen = model ?? this.#provider.model;

    // The model is part of the cache key. Without it, switching models would
    // return the previous model's answer and quietly make the picker a no-op.
    const key = `${chosen}:${fingerprint}`;

    // Reviewing an unchanged diagram twice should never cost twice. The
    // fingerprint ignores position, so dragging boxes around does not
    // invalidate a review that is still accurate.
    const cached = this.#cache.get(key);
    if (cached) return { ...cached, cached: true };

    const { findings, usage } = await this.#provider.generate(serializeGraph(graph), chosen);

    const result: ReviewResult = {
      findings: groundFindings(findings, graph),
      fingerprint,
      usage,
      provider: this.#provider.name,
      model: chosen,
      cached: false,
    };

    this.#remember(key, result);
    return result;
  }

  #remember(key: string, result: ReviewResult): void {
    if (this.#cache.size >= this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(key, result);
  }
}

/**
 * Discard anything the model cited that does not exist, and drop findings left
 * citing nothing.
 *
 * This is the difference between a review you can click on and a review you have
 * to fact-check by hand. A finding that points at `n_abc123` is verifiable: the
 * canvas either highlights that component or the finding was invented. Filtering
 * here means the UI can trust every id it receives, and the grounding claim the
 * product makes is enforced rather than hoped for.
 *
 * It runs for every provider, so a weaker model does not get to lower the bar.
 */
export function groundFindings(raw: readonly RawFinding[], graph: ArchGraph): Finding[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgeIds = new Set(graph.edges.map((e) => e.id));

  const grounded: Finding[] = [];
  for (const finding of raw) {
    const nodes = finding.nodeIds.filter((id) => nodeIds.has(id));
    const edges = finding.edgeIds.filter((id) => edgeIds.has(id));
    if (nodes.length === 0 && edges.length === 0) continue;

    grounded.push({
      // Namespaced so the UI can style model findings differently from rule
      // findings, and so a user can mute the reviewer without muting the rules.
      ruleId: 'ai-review',
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      nodeIds: nodes,
      edgeIds: edges,
    });
  }

  return grounded;
}
