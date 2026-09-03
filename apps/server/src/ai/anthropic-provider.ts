import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  ReviewSchema,
  SYSTEM_PROMPT,
  USER_PREFIX,
  type ProviderResult,
  type ReviewProvider,
} from './provider.ts';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
}

export class AnthropicReviewProvider implements ReviewProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly #client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-opus-5';
  }

  async generate(graphText: string, model?: string): Promise<ProviderResult> {
    const response = await this.#client.messages.parse({
      model: model ?? this.model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      // The system prompt is identical on every request, so caching it means
      // only the diagram itself is charged at the full input rate.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      output_config: { format: zodOutputFormat(ReviewSchema) },
      messages: [{ role: 'user', content: `${USER_PREFIX}${graphText}` }],
    });

    return {
      findings: response.parsed_output?.findings ?? [],
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }

  /**
   * Models this key can call.
   *
   * Listed live rather than hardcoded: a static list goes stale the moment a new
   * model ships, and silently offering one the account cannot reach is worse
   * than offering nothing.
   */
  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const model of this.#client.models.list()) ids.push(model.id);
    return ids;
  }
}
