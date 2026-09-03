import { GoogleGenAI } from '@google/genai';
import { ReviewSchema, SYSTEM_PROMPT, USER_PREFIX, type ProviderResult, type ReviewProvider } from './provider.ts';

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
}

/**
 * Response shape, expressed in the schema dialect the Gemini API accepts.
 *
 * Written out by hand rather than generated from the Zod schema: the API takes
 * a restricted OpenAPI subset, and a general Zod-to-JSON-Schema conversion emits
 * keywords it rejects. The Zod schema still validates the reply, so the two
 * cannot silently diverge without a parse failure.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          nodeIds: { type: 'array', items: { type: 'string' } },
          edgeIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'title', 'detail', 'nodeIds', 'edgeIds'],
      },
    },
  },
  required: ['findings'],
};

export class GeminiReviewProvider implements ReviewProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly #client: GoogleGenAI;

  constructor(options: GeminiProviderOptions) {
    this.#client = new GoogleGenAI({ apiKey: options.apiKey });
    // 3.7-flash is frequently capacity-constrained and answers 503; 3.5-flash is
    // the newest tier that reliably serves this workload. Override with
    // REVIEW_MODEL when that changes.
    this.model = options.model ?? 'gemini-3.5-flash';
  }

  async generate(graphText: string, model?: string): Promise<ProviderResult> {
    const response = await withRetry(() =>
      this.#client.models.generateContent({
        model: model ?? this.model,
        contents: `${USER_PREFIX}${graphText}`,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 8000,
        },
      }),
    );

    const usage = response.usageMetadata;
    return {
      // A schema-constrained reply is still parsed and validated rather than
      // trusted. The constraint is the provider's promise, not a guarantee.
      findings: parseFindings(response.text),
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
        cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
      },
    };
  }

  /**
   * Models this key can call, filtered to those that support generateContent.
   *
   * The full list includes image, speech and embedding models that would fail
   * the moment a user picked them. Offering only what can actually serve a
   * review keeps the dropdown honest.
   */
  async listModels(): Promise<string[]> {
    const models: string[] = [];

    for await (const model of await this.#client.models.list()) {
      const actions = model.supportedActions ?? [];
      if (actions.length > 0 && !actions.includes('generateContent')) continue;

      const id = (model.name ?? '').replace(/^models\//, '');
      if (id && isReviewCapable(id)) models.push(id);
    }

    return models.sort(byNewestFirst);
  }
}

/**
 * Parse and validate the model's reply.
 *
 * A schema-constrained response is still checked rather than trusted: the
 * constraint is the provider's promise, not a guarantee, and a truncated reply
 * is still syntactically plausible JSON right up until it is not.
 *
 * A malformed reply yields no findings rather than an error. The rule engine has
 * already produced the results the user actually depends on, so losing the
 * optional second opinion is not worth failing the whole request over.
 */
export function parseFindings(text: string | undefined): ProviderResult['findings'] {
  if (!text) return [];

  try {
    const parsed = ReviewSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.findings : [];
  } catch {
    return [];
  }
}

/** Status codes worth trying again: transient capacity and rate limiting. */
const RETRYABLE = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

/**
 * Retry transient upstream failures with exponential backoff and jitter.
 *
 * Popular Gemini models answer 503 "experiencing high demand" often enough that
 * a single attempt makes the review feel broken when it is merely busy. Jitter
 * matters because without it every concurrent reviewer in the process retries in
 * the same instant and recreates the spike that caused the 503.
 *
 * Only idempotent read-shaped calls go through here. Retrying is safe precisely
 * because a review has no side effects.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  attempts = MAX_ATTEMPTS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) throw error;

      const backoff = 500 * 2 ** attempt;
      await sleep(backoff + Math.random() * 250);
    }
  }

  throw lastError;
}

export function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && RETRYABLE.has(status);
}

/**
 * Keep only models that can actually serve a review.
 *
 * The list endpoint returns far more than it will accept. Media, speech and
 * embedding models cannot answer at all, and the 2.5 family is still listed
 * while returning 404 "no longer available to new users" the moment it is
 * called. Offering a model that 404s is worse than not offering it, so the
 * filter is deliberately conservative: current Gemini families and the moving
 * `-latest` aliases only.
 */
export function isReviewCapable(id: string): boolean {
  if (/image|tts|embedding|transcribe|lyria|robotics|omni|banana|computer-use/.test(id)) return false;
  // Research and agent presets are priced and shaped for a different job.
  if (/^(gemma|deep-research|antigravity)/.test(id)) return false;
  // customtools variants expect a tool declaration this request does not send.
  if (id.includes('customtools')) return false;

  return /^gemini-3/.test(id) || /-latest$/.test(id);
}

/** Highest version first, so the most capable option heads the dropdown. */
export function byNewestFirst(a: string, b: string): number {
  const version = (id: string): number => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const delta = version(b) - version(a);
  return delta !== 0 ? delta : a.localeCompare(b);
}
